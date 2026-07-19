import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, formatEther, formatUnits, AbiCoder, keccak256 } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_NFPM_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';
import { tg } from './telegram.js';
import { withdrawV3, withdrawV4, swapBackAfterWithdraw } from './lp_withdraw.js';
import { getSqrtRatioAtTick, getAmountsForLiquidity, getEthUsdPrice, getTokenUsdPricesFromTick } from './v3_math.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);

const { sqrt } = Math;

const AUTO_CLOSE_DRY = process.env.AUTO_CLOSE_DRY !== '0';
const FORCE_TRIGGER = process.env.FORCE_TRIGGER === '1';
const LIVE = process.env.DRY === '0' && process.env.PRIVATE_KEY;

// --- TP config constants ---
const TP_ARM_THRESHOLD = 7;    // % net gain to arm
const TP_TRAIL_DISTANCE = 1;   // % drop from peak to trigger
const DEFAULT_POSITION_VALUE_ETH = 0.01; // standard auto-open position value

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [], monitor: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function computeV4PoolId(key) {
  return keccak256(abi.encode(
    ['tuple(address,address,uint24,int24,address)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
  ));
}

function tickToPrice(tick) {
  return 1.0001 ** tick;
}

export function ilConcentrated(entryPrice, currentPrice, tickLower, tickUpper) {
  const r = currentPrice / entryPrice;
  const sqrtR = sqrt(r);
  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);

  // Below range: position fully in token0, value drops with price
  if (currentPrice <= priceLower) return 1 - 1 / r;
  // Above range: position fully in token1, value drops as r rises
  if (currentPrice >= priceUpper) return -(r - 1);
  // In range: standard concentrated LP formula
  return 2 * sqrtR / (1 + r) - 1;
}

async function getV3Position(provider, tokenId) {
  try {
    const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, provider);
    const pos = await nfpm.positions.staticCall(tokenId);
    return pos;
  } catch {
    return null;
  }
}

async function getPoolSlot0(provider, poolAddr) {
  const slot0Raw = await provider.call({ to: poolAddr, data: '0x3850c7bd' });
  const [sqrtPriceX96, tick] = AbiCoder.defaultAbiCoder().decode(
    ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'], slot0Raw
  );
  return { sqrtPriceX96: Number(sqrtPriceX96), tick: Number(tick) };
}

// Sanity: validate IL input data is not corrupted by RPC glitch
function sanityCheck(pos, currentTick, sqrtPriceX96) {
  if (!pos) return 'position null';
  if (pos.liquidity === 0n) return 'liquidity zero';
  if (typeof currentTick !== 'number' || isNaN(currentTick)) return 'invalid currentTick';
  if (typeof pos.tickLower === 'undefined' || typeof pos.tickUpper === 'undefined') return 'missing tick bounds';
  if (!sqrtPriceX96 || sqrtPriceX96 <= 0) return 'invalid sqrtPriceX96';
  return null;
}

// ===== CLOSE CONFIRMATION =====
// Double-confirms a position is truly closed via fresh on-chain queries,
// NOT relying on cached/mid-computation data. Prevents false removals.
async function confirmPositionClosed(provider, tokenId, dex) {
  try {
    if (dex === 'V3') {
      const nfpm = new Contract(V3.nfpm, ['function ownerOf(uint256) view returns (address)', 'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'], provider);
      // If ownerOf reverts, position NFT is burned — definitely closed
      let owner;
      try { owner = await nfpm.ownerOf(tokenId); } catch { return true; }
      if (!owner) return true;
      // Owner exists — check liquidity directly
      const pos = await nfpm.positions.staticCall(tokenId);
      const closed = pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n;
      if (!closed) console.warn(`  confirmPositionClosed V3 #${tokenId}: liquidity=${pos.liquidity.toString()} tokensOwed=${pos.tokensOwed0}/${pos.tokensOwed1} — NOT closed`);
      return closed;
    }
    if (dex === 'V4') {
      const nfpm = new Contract(V4_NFPM, ['function ownerOf(uint256) view returns (address)'], provider);
      let owner;
      try { owner = await nfpm.ownerOf(tokenId); } catch { return true; }
      if (!owner) return true;
      // V4: check position liquidity directly
      const reader = new Contract(V4_NFPM, ['function getPositionLiquidity(uint256) view returns (uint128)'], provider);
      const liq = await reader.getPositionLiquidity(BigInt(tokenId));
      const closed = liq === 0n;
      if (!closed) console.warn(`  confirmPositionClosed V4 #${tokenId}: liquidity=${liq} — NOT closed`);
      return closed;
    }
    return false;
  } catch (e) {
    console.warn(`  confirmPositionClosed error #${tokenId}: ${e.shortMessage || e.message.slice(0, 80)}`);
    return false; // On error, DON'T remove (fail safe)
  }
}

// ===== TRAILING TAKE-PROFIT =====
// Pure function: computes TP state from netGainPct and previous entry state.
// Returns { tpArmed, tpPeak, tpTriggered, tpJustArmed } — caller persists to entry.
function checkTrailingTakeProfit(netGainPct, entry) {
  const wasArmed = entry.tpArmed === true;
  const prevPeak = typeof entry.tpPeak === 'number' ? entry.tpPeak : 0;

  let tpArmed = wasArmed;
  let tpPeak = prevPeak;
  let tpTriggered = false;
  let tpJustArmed = false;

  if (!wasArmed) {
    // Belum armed — check apakah netGainPct mencapai threshold arm
    if (netGainPct >= TP_ARM_THRESHOLD) {
      tpArmed = true;
      tpPeak = netGainPct;
      tpJustArmed = true;
    }
  } else {
    // Already armed — update peak if higher
    if (netGainPct > tpPeak) tpPeak = netGainPct;
    // Trigger jika turun >= trail distance dari peak
    if (netGainPct <= tpPeak - TP_TRAIL_DISTANCE) tpTriggered = true;
  }

  return { tpArmed, tpPeak, tpTriggered, tpJustArmed };
}

// ===== USD PRICE HELPERS =====
// WETH address (from LP_V3_CASHCAT_WETH.token1) — duplicated from v3_math.js for DexScreener fallback
const WETH_ADDR_MONITOR = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

// Derive token0/token1 USD prices: first try tick-based (WETH pairs), then DexScreener.
async function getTokenUsdPrices(token0, token1, currentTick, sqrtPriceX96, provider) {
  // Try tick-based derivation first (fast, no external API)
  const tickPrices = getTokenUsdPricesFromTick(token0, token1, currentTick);
  if (tickPrices) return tickPrices;
  // Fallback: fetch ETH price directly
  const ethUsd = await getEthUsdPrice();
  if (!ethUsd) return null;
  // Try DexScreener API for non-WETH pairs
  try {
    const pairAddr = provider ? await resolveV3PoolAnyFee(token0, token1, provider) : null;
    if (pairAddr) {
      const url = `https://api.dexscreener.com/latest/dex/pair/robinhood/${pairAddr.toLowerCase()}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data?.pair?.priceUsd) {
        const baseAddr = data.pair.baseToken?.address?.toLowerCase();
        const t0l = token0.toLowerCase(), t1l = token1.toLowerCase();
        if (baseAddr === t0l) return { token0Usd: Number(data.pair.priceUsd), token1Usd: 0 };
        if (baseAddr === t1l) return { token0Usd: 0, token1Usd: Number(data.pair.priceUsd) };
      }
    }
  } catch {}
  return null;
}

async function resolveV3PoolAnyFee(token0, token1, provider) {
  const factory = new Contract(V3.factory, ['function getPool(address,address,uint24) view returns (address)'], provider);
  for (const f of [10000, 3000, 500, 100]) {
    try {
      const addr = await factory.getPool(token0, token1, f);
      if (addr && addr !== '0x0000000000000000000000000000000000000000') return addr;
    } catch {}
  }
  return null;
}

// Compute current USD value of a position from its live amounts.
async function computePositionUsdValue(provider, liquidity, sqrtPriceX96, tickLower, tickUpper, currentTick, tokensOwed0, tokensOwed1, token0, token1) {
  const prices = await getTokenUsdPrices(token0, token1, currentTick, sqrtPriceX96, provider);
  if (!prices || (prices.token0Usd === 0 && prices.token1Usd === 0)) return null;

  const { amount0, amount1 } = getAmountsForLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper);
  const total0 = amount0 + tokensOwed0;
  const total1 = amount1 + tokensOwed1;

  let valueUsd = 0;
  // Convert amounts to float for USD calculation
  if (prices.token0Usd > 0) {
    try {
      const d0 = await (new Contract(token0, ERC20_ABI, provider)).decimals().catch(() => 18);
      valueUsd += Number(formatUnits(total0, d0)) * prices.token0Usd;
    } catch {}
  }
  if (prices.token1Usd > 0) {
    try {
      const d1 = await (new Contract(token1, ERC20_ABI, provider)).decimals().catch(() => 18);
      valueUsd += Number(formatUnits(total1, d1)) * prices.token1Usd;
    } catch {}
  }
  return valueUsd;
}

async function getV3PoolAddress(provider, token0, token1, fee) {
  const factory = new Contract(V3.factory, ['function getPool(address,address,uint24) view returns (address)'], provider);
  return await factory.getPool(token0, token1, fee);
}

// Check IL and trigger auto-close if needed (V3 only)
async function checkV3(provider, entry, config) {
  if (!entry?.tokenId) return null;
  const tokenId = BigInt(entry.tokenId);
  const pos = await getV3Position(provider, tokenId);
  if (!pos) return { error: 'position burned or not found' };

  // Derive pool address from entry's own token0/token1/fee (NOT hardcoded CASHCAT)
  let poolAddr;
  let poolSymbol = entry.pool || '?/?';
  if (entry.token0 && entry.token1 && entry.fee != null) {
    try {
      poolAddr = await getV3PoolAddress(provider, entry.token0, entry.token1, entry.fee);
    } catch {
      return { error: `cannot resolve pool address for ${poolSymbol}` };
    }
  } else {
    // Legacy fallback — entry without token0/token1/fee
    poolAddr = LP_V3_CASHCAT_WETH.pool;
    poolSymbol = LP_V3_CASHCAT_WETH.symbol;
  }

  const { tick: currentTick, sqrtPriceX96 } = await getPoolSlot0(provider, poolAddr);

  // SANITY GUARD: reject glitch data
  const sanity = sanityCheck(pos, currentTick, sqrtPriceX96);
  if (sanity) return { error: sanity };

  const price = tickToPrice(currentTick);
  const entryTick = Number(entry.entryTick ?? currentTick);
  const entryPrice = tickToPrice(entryTick);

  const ilPct = ilConcentrated(entryPrice, price, Number(pos.tickLower), Number(pos.tickUpper)) * 100;
  const feeValueEth = Number(formatEther(pos.tokensOwed1)) + Number(formatUnits(pos.tokensOwed0, 18)) * price;
  const outOfRange = currentTick < Number(pos.tickLower) || currentTick > Number(pos.tickUpper);
  const threshold = Number(config.ilExitThresholdPct);
  const ilExceedsThreshold = ilPct < -threshold;

  // --- Trailing take-profit (USD-based) ---
  // netProfitPct = (currentValueUsd - entryValueUsd) / entryValueUsd * 100
  // Hanya aktif jika entryValueUsd tersimpan (posisi baru setelah code ini deploy)
  let netProfitPct = null;
  let currentValueUsd = null;
  let entryValueUsd = entry.entryValueUsd ?? null;
  let tp = { tpArmed: false, tpPeak: 0, tpTriggered: false, tpJustArmed: false };

  if (entryValueUsd !== null && entryValueUsd > 0) {
    currentValueUsd = await computePositionUsdValue(
      provider, pos.liquidity, sqrtPriceX96,
      Number(pos.tickLower), Number(pos.tickUpper), currentTick,
      pos.tokensOwed0, pos.tokensOwed1,
      entry.token0 || pos.token0, entry.token1 || pos.token1
    );
    if (currentValueUsd !== null && currentValueUsd > 0) {
      netProfitPct = ((currentValueUsd - entryValueUsd) / entryValueUsd) * 100;
      tp = checkTrailingTakeProfit(netProfitPct, entry);
    }
  } else {
    // Existing position tanpa entryValueUsd — tidak bisa arm TP
    // Stop-loss (IL) tetap berjalan seperti biasa
    entry.tpArmed = false;
    entry.tpPeak = 0;
  }
  entry.tpArmed = tp.tpArmed;
  entry.tpPeak = tp.tpPeak;

  const result = {
    dex: 'V3',
    pool: poolSymbol,
    tokenId: entry.tokenId,
    currentTick,
    tickLower: Number(pos.tickLower),
    tickUpper: Number(pos.tickUpper),
    price,
    entryPrice,
    ilPct,
    feeValueEth,
    entryValueUsd,
    currentValueUsd,
    netProfitPct,
    tpArmed: tp.tpArmed,
    tpPeak: tp.tpPeak,
    tpTriggered: tp.tpTriggered,
    tpJustArmed: tp.tpJustArmed,
    liquidity: formatUnits(pos.liquidity, 18),
    outOfRange,
    ilExceedsThreshold,
    shouldNotify: ilExceedsThreshold || outOfRange,
  };

  // Notify jika baru armed
  if (tp.tpJustArmed) {
    const gainStr = netProfitPct !== null ? netProfitPct.toFixed(1) : '?';
    await tg(`\u{1F3AF} Take-profit ARMED #${entry.tokenId}: +${gainStr}% (\$${currentValueUsd?.toFixed(2) || '?'}) — mulai lacak puncak`).catch(() => {});
  }

  // AUTO-CLOSE: trigger if IL exceeds threshold OR TP triggered, + sanity passes, or FORCE_TRIGGER=1
  const shouldTrigger = ((ilExceedsThreshold || tp.tpTriggered) && pos.liquidity > 0n) || FORCE_TRIGGER;
  if (shouldTrigger) {
    let reason;
    if (FORCE_TRIGGER) {
      reason = 'FORCE_TRIGGER=1';
    } else if (tp.tpTriggered) {
      reason = `TAKE-PROFIT: profit turun dari ${tp.tpPeak.toFixed(1)}% ke ${netProfitPct !== null ? netProfitPct.toFixed(1) : '?'}% (trail ${TP_TRAIL_DISTANCE}%)`;
    } else {
      reason = `IL=${ilPct.toFixed(2)}% < -${threshold}%`;
    }
    console.log(`>>> ${AUTO_CLOSE_DRY ? 'AKAN auto-close' : 'AUTO-CLOSING'} #${entry.tokenId} (${reason})`);

    if (AUTO_CLOSE_DRY) {
      await tg(`\u{1F514} LP Monitor — AUTO-CLOSE DRY\n` +
        `Position #${entry.tokenId} (${result.pool})\n` +
        `Trigger: ${reason}\n` +
        `AKAN di-close otomatis jika AUTO_CLOSE_DRY=0`).catch(() => {});
    } else if (LIVE) {
      const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
      if (tp.tpTriggered) {
        const gainStr = netProfitPct !== null ? netProfitPct.toFixed(1) : '?';
        await tg(`\u{2705} TAKE-PROFIT #${entry.tokenId}: profit turun dari ${tp.tpPeak.toFixed(1)}% ke ${gainStr}% (trail ${TP_TRAIL_DISTANCE}%)\n` +
          `Nilai saat ini: \$${currentValueUsd?.toFixed(2) || '?'} | Posisi ditutup.`).catch(() => {});
      } else {
        await tg(`\u{1F534} AUTO-CLOSING position #${entry.tokenId}\nIL: ${ilPct.toFixed(2)}%`).catch(() => {});
      }
      try {
        const wdResult = await withdrawV3(provider, wallet, tokenId, config);
        if (wdResult?._burnFailed) {
          result.autoCloseFailed = `BURN FAILED — NFT #${entry.tokenId} masih ada (collect OK, burn tidak terjadi)`;
          await tg(`\u{26A0}\u{FE0F} AUTO-CLOSE #${entry.tokenId}: COLLECT OK, BURN FAILED\n` +
            `NFT ${entry.tokenId} masih dimiliki wallet.\n` +
            `Coba burn manual atau verifikasi on-chain.`).catch(() => {});
          // autoCloseFailed=true → monitorOnce TIDAK remove dari state, skip swap-back
        } else {
          result.autoClosed = true;
          const feeLine = wdResult?.fee0 ? `<code>${wdResult.fee0} ${wdResult.sym0} + ${wdResult.fee1} ${wdResult.sym1}</code>` : '';
          if (!tp.tpTriggered) {
            await tg(`\u{2705} AUTO-CLOSED #${entry.tokenId} (IL=${ilPct.toFixed(2)}% < -${threshold}%)\n` +
              `${feeLine ? `Fees collected: ${feeLine}\n` : ''}` +
              `Mulai swap-back token ke ETH...`).catch(() => {});
          }

          // Auto swap-back (otomatis, tanpa flag SWAP_BACK)
          if (wdResult?.token0 && wdResult?.token1) {
            const swapResult = await swapBackAfterWithdraw(provider, wallet, [wdResult.token0, wdResult.token1], config, true);
            result.swapBack = swapResult;
            if (swapResult?.summary) {
              await tg(`\u{1F504} Swap-back #${entry.tokenId}: ${swapResult.summary}` +
                (swapResult.failed?.length ? `\n\u{26A0}\u{FE0F} Gagal: ${swapResult.failedSymbols?.join(', ') || swapResult.failed.join(', ')}` : '')).catch(() => {});
            }
          }
        }
      } catch (e) {
        const errMsg = e.shortMessage || e.message || String(e);
        result.autoCloseFailed = errMsg;
        await tg(`\u{274C} AUTO-CLOSE FAILED #${entry.tokenId}: ${errMsg.slice(0,120)}`).catch(() => {});
      }
    } else {
      console.log('    (skip: not live, set DRY=0 PRIVATE_KEY=0x.. to auto-close)');
    }
  }

  return result;
}

async function checkV4(provider, entry, config) {
  if (entry?.dex !== 'V4') return null;
  if (!entry?.tokenId) { console.log('  V4 entry tanpa tokenId, skip'); return null; }

  const stateView = new Contract(V4.stateView, [
    'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)',
  ], provider);

  // Use entry's own pool data (NOT hardcoded CASHCAT/USDG)
  let poolId;
  let poolSymbol = entry.pool || '?/?';
  if (entry.poolId) {
    poolId = entry.poolId;
  } else if (entry.currency0 && entry.currency1 && entry.fee != null && entry.tickSpacing != null && entry.hooks != null) {
    poolId = computeV4PoolId({
      currency0: entry.currency0, currency1: entry.currency1,
      fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks,
    });
  } else {
    return { error: 'V4 entry missing poolId or pool key fields' };
  }

  let currentTick;
  let sqrtPriceX96;
  try {
    const slot0 = await stateView.getSlot0.staticCall(poolId);
    sqrtPriceX96 = BigInt(slot0[0]);
    currentTick = Number(slot0[1]);
  } catch {
    return { error: 'V4 pool not initialized' };
  }

  // Check INDIVIDUAL position liquidity (bukan total pool liquidity)
  const v4Reader = new Contract(V4_NFPM, [
    'function getPositionLiquidity(uint256) view returns (uint128)',
  ], provider);
  let posLiq;
  try {
    posLiq = await v4Reader.getPositionLiquidity(BigInt(entry.tokenId));
  } catch {
    return { error: 'V4 position not found (getPositionLiquidity failed)' };
  }
  if (posLiq === 0n) {
    return { error: 'position liquidity zero', dex: 'V4', tokenId: entry.tokenId };
  }

  // Legacy position tanpa entryTick — skip IL calc (tapi TETAP terhapus kalau liquidity=0)
  const hasILData = typeof entry.entryTick === 'number' && typeof entry.tickLower === 'number' && typeof entry.tickUpper === 'number';
  if (!hasILData) {
    return {
      error: 'V4 legacy position (no entryTick/tickBounds) — skip IL calc',
      dex: 'V4', pool: poolSymbol, tokenId: entry.tokenId,
      currentTick, price: tickToPrice(currentTick),
    };
  }

  const price = tickToPrice(currentTick);
  const entryPrice = tickToPrice(entry.entryTick);

  const ilPct = ilConcentrated(entryPrice, price, entry.tickLower, entry.tickUpper) * 100;
  const outOfRange = currentTick < entry.tickLower || currentTick > entry.tickUpper;
  const threshold = Number(config.ilExitThresholdPct);
  const ilExceedsThreshold = ilPct < -threshold;

  // --- Trailing take-profit (USD-based) ---
  let netProfitPct = null;
  let currentValueUsd = null;
  let entryValueUsd = entry.entryValueUsd ?? null;
  let tp = { tpArmed: false, tpPeak: 0, tpTriggered: false, tpJustArmed: false };
  const token0 = entry.currency0 || entry.token0;
  const token1 = entry.currency1 || entry.token1;

  if (entryValueUsd !== null && entryValueUsd > 0 && token0 && token1) {
    currentValueUsd = await computePositionUsdValue(
      provider, posLiq, sqrtPriceX96,
      entry.tickLower, entry.tickUpper, currentTick,
      0n, 0n, // V4 NFPM tidak expose tokensOwed, assume 0 (conservative)
      token0, token1
    );
    if (currentValueUsd !== null && currentValueUsd > 0) {
      netProfitPct = ((currentValueUsd - entryValueUsd) / entryValueUsd) * 100;
      tp = checkTrailingTakeProfit(netProfitPct, entry);
    }
  } else {
    entry.tpArmed = false;
    entry.tpPeak = 0;
  }
  entry.tpArmed = tp.tpArmed;
  entry.tpPeak = tp.tpPeak;

  const sanity = sanityCheck(
    { liquidity: posLiq, tickLower: entry.tickLower, tickUpper: entry.tickUpper },
    currentTick, 1
  );
  if (sanity) return { error: `V4 ${sanity}` };

  const result = {
    dex: 'V4',
    pool: poolSymbol,
    tokenId: entry.tokenId,
    currentTick,
    tickLower: entry.tickLower,
    tickUpper: entry.tickUpper,
    price,
    entryPrice,
    ilPct,
    entryValueUsd,
    currentValueUsd,
    netProfitPct,
    tpArmed: tp.tpArmed,
    tpPeak: tp.tpPeak,
    tpTriggered: tp.tpTriggered,
    tpJustArmed: tp.tpJustArmed,
    posLiquidity: posLiq.toString(),
    outOfRange,
    ilExceedsThreshold,
    shouldNotify: ilExceedsThreshold || outOfRange,
  };

  // Notify jika baru armed
  if (tp.tpJustArmed) {
    const gainStr = netProfitPct !== null ? netProfitPct.toFixed(1) : '?';
    await tg(`\u{1F3AF} Take-profit ARMED V4 #${entry.tokenId}: +${gainStr}% (\$${currentValueUsd?.toFixed(2) || '?'}) — mulai lacak puncak`).catch(() => {});
  }

  // AUTO-CLOSE: trigger if IL exceeds threshold OR TP triggered, or FORCE_TRIGGER=1
  const shouldTrigger = ((ilExceedsThreshold || tp.tpTriggered) && posLiq > 0n) || FORCE_TRIGGER;
  if (shouldTrigger) {
    let reason;
    if (FORCE_TRIGGER) {
      reason = 'FORCE_TRIGGER=1';
    } else if (tp.tpTriggered) {
      reason = `TAKE-PROFIT: profit turun dari ${tp.tpPeak.toFixed(1)}% ke ${netProfitPct !== null ? netProfitPct.toFixed(1) : '?'}% (trail ${TP_TRAIL_DISTANCE}%)`;
    } else {
      reason = `IL=${ilPct.toFixed(2)}% < -${threshold}%`;
    }
    console.log(`>>> ${AUTO_CLOSE_DRY ? 'AKAN auto-close' : 'AUTO-CLOSING'} V4 #${entry.tokenId} (${reason})`);

    if (AUTO_CLOSE_DRY) {
      await tg(`\u{1F514} LP Monitor — AUTO-CLOSE DRY (V4)\n` +
        `Position #${entry.tokenId} (${result.pool})\n` +
        `Trigger: ${reason}\n` +
        `AKAN di-close otomatis jika AUTO_CLOSE_DRY=0`).catch(() => {});
    } else if (LIVE) {
      const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
      if (tp.tpTriggered) {
        const gainStr = netProfitPct !== null ? netProfitPct.toFixed(1) : '?';
        await tg(`\u{2705} TAKE-PROFIT V4 #${entry.tokenId}: profit turun dari ${tp.tpPeak.toFixed(1)}% ke ${gainStr}% (trail ${TP_TRAIL_DISTANCE}%)\n` +
          `Nilai saat ini: \$${currentValueUsd?.toFixed(2) || '?'} | Posisi ditutup.`).catch(() => {});
      } else {
        await tg(`\u{1F534} AUTO-CLOSING V4 position #${entry.tokenId}\nIL: ${ilPct.toFixed(2)}%`).catch(() => {});
      }
      try {
        const wdResult = await withdrawV4(provider, wallet, config, entry.tokenId);
        result.autoClosed = true;
        if (!tp.tpTriggered) {
          await tg(`\u{2705} AUTO-CLOSED V4 #${entry.tokenId} (IL=${ilPct.toFixed(2)}% < -${threshold}%)\n` +
            `Mulai swap-back token ke ETH...`).catch(() => {});
        }

        // Auto swap-back (otomatis, tanpa flag SWAP_BACK)
        if (wdResult?.token0 && wdResult?.token1) {
          const swapResult = await swapBackAfterWithdraw(provider, wallet, [wdResult.token0, wdResult.token1], config, true);
          result.swapBack = swapResult;
          if (swapResult?.summary) {
            await tg(`\u{1F504} Swap-back V4 #${entry.tokenId}: ${swapResult.summary}` +
              (swapResult.failed?.length ? `\n\u{26A0}\u{FE0F} Gagal: ${swapResult.failedSymbols?.join(', ') || swapResult.failed.join(', ')}` : '')).catch(() => {});
          }
        }
      } catch (e) {
        const errMsg = e.shortMessage || e.message || String(e);
        result.autoCloseFailed = errMsg;
        await tg(`\u{274C} AUTO-CLOSE FAILED V4 #${entry.tokenId}: ${errMsg.slice(0,120)}`).catch(() => {});
      }
    } else {
      console.log('    (skip: not live, set DRY=0 PRIVATE_KEY=0x.. to auto-close)');
    }
  }

  return result;
}

async function monitorOnce(provider, config) {
  const state = loadState();
  state.monitor ??= {};
  state.monitor.consecutiveFails ??= 0;

  if (!state.positions.length) {
    console.log('No positions in state. Run lp_deposit.js first.');
    saveState(state);
    return;
  }

  console.log(`\n=== LP Monitor ${new Date().toISOString()} ===`);
  let anyFail = false;
  const toRemove = [];

  for (const entry of state.positions) {
    if (entry.dex === 'V3') {
      const result = await checkV3(provider, entry, config);
      if (!result || result.error) {
        console.log(`  V3 #${entry.tokenId}: ${result?.error ?? 'null'}`);
        // DO NOT remove immediately — double-confirm on-chain first
        if (result?.error === 'liquidity zero' || result?.error === 'position burned or not found') {
          const confirmed = await confirmPositionClosed(provider, BigInt(entry.tokenId), 'V3');
          if (confirmed) {
            toRemove.push(entry);
          } else {
            console.warn(`  V3 #${entry.tokenId}: flagged for removal but on-chain confirmation FAILED — keeping in state`);
          }
        } else {
          anyFail = true;
        }
        continue;
      }

      const rangePct = ((result.currentTick - result.tickLower) / (result.tickUpper - result.tickLower) * 100).toFixed(1);
      const statusIcon = result.outOfRange ? 'OUT' : 'IN';
      console.log(`  V3 #${result.tokenId}: IL=${result.ilPct.toFixed(2)}% fee=${result.feeValueEth.toFixed(6)}ETH liq=${result.liquidity.slice(0,8)} range=${rangePct}% [${statusIcon}]`);

      // Suppress generic notify if auto-close already sent its own message
      if (result.autoClosed || result.autoCloseFailed) {
        if (result.autoClosed) toRemove.push(entry);
      } else if (result.shouldNotify) {
        const parts = [
          `\u{1F514} LP Monitor: ${result.pool} #${result.tokenId}`,
          `IL: ${result.ilPct.toFixed(2)}% (threshold: -${config.ilExitThresholdPct}%)`,
          `Fees earned: ${result.feeValueEth.toFixed(6)} ETH`,
          `Entry: ${result.entryPrice.toFixed(8)} | Now: ${result.price.toFixed(8)}`,
        ];
        if (result.outOfRange) parts.push('\u{26A0}\u{FE0F} OUT OF RANGE');
        if (result.ilExceedsThreshold) parts.push('\u{26A0}\u{FE0F} IL exceeds threshold');
        await tg(parts.join('\n')).catch(() => {});
      }
    } else if (entry.dex === 'V4') {
      const result = await checkV4(provider, entry, config);
      if (!result || result.error) {
        const isLegacy = result?.error?.includes('legacy');
        console.log(`  V4 #${entry.tokenId}: ${result?.error ?? 'null'}`);
        if (result?.error?.includes('position burned') || result?.error?.includes('getPositionLiquidity failed') || result?.error?.includes('liquidity zero')) {
          const confirmed = await confirmPositionClosed(provider, BigInt(entry.tokenId), 'V4');
          if (confirmed) {
            toRemove.push(entry);
          } else {
            console.warn(`  V4 #${entry.tokenId}: flagged for removal but on-chain confirmation FAILED — keeping in state`);
          }
        } else if (!isLegacy) {
          anyFail = true;
        }
        continue;
      }

      const rangePct = ((result.currentTick - result.tickLower) / (result.tickUpper - result.tickLower) * 100).toFixed(1);
      const statusIcon = result.outOfRange ? 'OUT' : 'IN';
      console.log(`  V4 #${result.tokenId}: IL=${result.ilPct.toFixed(2)}% range=${rangePct}% [${statusIcon}]`);

      if (result.autoClosed || result.autoCloseFailed) {
        if (result.autoClosed) toRemove.push(entry);
      } else if (result.shouldNotify) {
        const parts = [
          `\u{1F514} LP Monitor: ${result.pool} #${result.tokenId}`,
          `IL: ${result.ilPct.toFixed(2)}% (threshold: -${config.ilExitThresholdPct}%)`,
          `Entry: ${result.entryPrice.toFixed(8)} | Now: ${result.price.toFixed(8)}`,
        ];
        if (result.outOfRange) parts.push(`\u{26A0}\u{FE0F} OUT OF RANGE`);
        if (result.ilExceedsThreshold) parts.push(`\u{26A0}\u{FE0F} IL exceeds threshold`);
        await tg(parts.join('\n')).catch(() => {});
      }
    }
  }

  // Clean up auto-closed positions from state
  if (toRemove.length > 0) {
    state.positions = state.positions.filter(p => !toRemove.includes(p));
    console.log(`  Cleaned ${toRemove.length} auto-closed position(s) from state`);
  }

  if (anyFail) {
    state.monitor.consecutiveFails++;
  } else {
    state.monitor.consecutiveFails = 0;
  }

  if (state.monitor.consecutiveFails >= Number(config.maxConsecutiveFails)) {
    const msg = `\u{26A0}\u{FE0F} LP Monitor circuit breaker: ${state.monitor.consecutiveFails} consecutive failures`;
    console.log(`\n${msg}`);
    await tg(msg).catch(() => {});
  }

  saveState(state);
}

// ===== PERIODIC POSITION REPORT (every 5 minutes) =====
// Sends a Telegram notification for each active position with current metrics.
// Skips silently if no positions active. Read-only — does not modify state.
async function sendPeriodicReport(provider) {
  const state = loadState();
  if (!state.positions?.length) return;

  for (const entry of state.positions) {
    try {
      if (entry.dex === 'V3') await _reportV3(provider, entry);
      else if (entry.dex === 'V4') await _reportV4(provider, entry);
    } catch (e) {
      console.error(`Periodic report error #${entry.tokenId}: ${e.shortMessage || e.message}`);
    }
  }
}

async function _reportV3(provider, entry) {
  const tokenId = BigInt(entry.tokenId);
  const pos = await getV3Position(provider, tokenId);
  if (!pos || pos.liquidity === 0n) return;

  let poolAddr;
  if (entry.token0 && entry.token1 && entry.fee != null) {
    try { poolAddr = await getV3PoolAddress(provider, entry.token0, entry.token1, entry.fee); } catch { return; }
  } else { return; }

  const { tick: currentTick, sqrtPriceX96 } = await getPoolSlot0(provider, poolAddr);
  const price = tickToPrice(currentTick);
  const entryTick = Number(entry.entryTick ?? currentTick);
  const entryPrice = tickToPrice(entryTick);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  const outOfRange = currentTick < tickLower || currentTick > tickUpper;
  const rangeTotal = tickUpper - tickLower;
  const rangePct = !outOfRange && rangeTotal > 0 ? ((currentTick - tickLower) / rangeTotal * 100).toFixed(1) : '?';
  const statusStr = outOfRange ? `OUT OF RANGE` : `IN RANGE (${rangePct}%)`;

  const ilPct = ilConcentrated(entryPrice, price, tickLower, tickUpper) * 100;

  let netProfitStr = 'N/A';
  let tpStr = 'N/A (no entry value)';
  let feeStr = '$0.00';
  const entryV = entry.entryValueUsd ?? null;

  if (entryV !== null && entryV > 0) {
    const currentV = await computePositionUsdValue(
      provider, pos.liquidity, sqrtPriceX96,
      tickLower, tickUpper, currentTick,
      pos.tokensOwed0, pos.tokensOwed1,
      entry.token0, entry.token1
    );
    if (currentV !== null && currentV > 0) {
      const np = ((currentV - entryV) / entryV) * 100;
      const chg = currentV - entryV;
      netProfitStr = `${np >= 0 ? '+' : ''}${np.toFixed(2)}% (${chg >= 0 ? '+' : ''}$${chg.toFixed(2)})`;

      const prices = await getTokenUsdPrices(entry.token0, entry.token1, currentTick, sqrtPriceX96, provider);
      if (prices) {
        const d0 = await (new Contract(entry.token0, ERC20_ABI, provider)).decimals().catch(() => 18);
        const d1 = await (new Contract(entry.token1, ERC20_ABI, provider)).decimals().catch(() => 18);
        const f0 = Number(formatUnits(pos.tokensOwed0, d0)) * (prices.token0Usd || 0);
        const f1 = Number(formatUnits(pos.tokensOwed1, d1)) * (prices.token1Usd || 0);
        feeStr = `$${(f0 + f1).toFixed(2)}`;
      }

      if (entry.tpArmed) {
        tpStr = `ARMED at peak ${entry.tpPeak.toFixed(1)}% (trail 1%)`;
      } else if (np >= 7) {
        tpStr = `reached +${np.toFixed(1)}% — arming next cycle`;
      } else {
        tpStr = np < 0 ? `not armed (need +7%)` : `not armed (need +${(7 - np).toFixed(1)}%)`;
      }
    }
  }

  await tg([
    `📊 Position Update #${entry.tokenId} (${entry.pool || '?'})`,
    `Status: ${statusStr}`,
    `IL: ${ilPct >= 0 ? '+' : ''}${ilPct.toFixed(2)}% | Net P&L: ${netProfitStr}`,
    `Fees: ${feeStr}`,
    `TP: ${tpStr}`,
  ].join('\n'));
}

async function _reportV4(provider, entry) {
  if (!entry.poolId && !(entry.currency0 && entry.currency1)) return;
  const poolId = entry.poolId || computeV4PoolId({
    currency0: entry.currency0, currency1: entry.currency1,
    fee: entry.fee, tickSpacing: entry.tickSpacing,
    hooks: entry.hooks || '0x0000000000000000000000000000000000000000',
  });

  const stateView = new Contract(V4.stateView, [
    'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)',
  ], provider);
  let currentTick, sqrtPriceX96;
  try {
    const slot0 = await stateView.getSlot0.staticCall(poolId);
    sqrtPriceX96 = BigInt(slot0[0]);
    currentTick = Number(slot0[1]);
  } catch { return; }

  const v4Reader = new Contract(V4_NFPM, [
    'function getPositionLiquidity(uint256) view returns (uint128)',
  ], provider);
  let posLiq;
  try { posLiq = await v4Reader.getPositionLiquidity(BigInt(entry.tokenId)); } catch { return; }
  if (posLiq === 0n) return;

  if (!entry.tickLower || !entry.tickUpper || !entry.entryTick) return;
  const tickLower = entry.tickLower;
  const tickUpper = entry.tickUpper;
  const entryTick = entry.entryTick;

  const price = tickToPrice(currentTick);
  const entryPrice = tickToPrice(entryTick);

  const outOfRange = currentTick < tickLower || currentTick > tickUpper;
  const rangeTotal = tickUpper - tickLower;
  const rangePct = !outOfRange && rangeTotal > 0 ? ((currentTick - tickLower) / rangeTotal * 100).toFixed(1) : '?';
  const statusStr = outOfRange ? `OUT OF RANGE` : `IN RANGE (${rangePct}%)`;

  const ilPct = ilConcentrated(entryPrice, price, tickLower, tickUpper) * 100;

  let netProfitStr = 'N/A';
  let tpStr = 'N/A (no entry value)';
  const token0 = entry.currency0 || entry.token0;
  const token1 = entry.currency1 || entry.token1;
  const entryV = entry.entryValueUsd ?? null;

  if (entryV !== null && entryV > 0 && token0 && token1) {
    const currentV = await computePositionUsdValue(
      provider, posLiq, sqrtPriceX96,
      tickLower, tickUpper, currentTick,
      0n, 0n, token0, token1
    );
    if (currentV !== null && currentV > 0) {
      const np = ((currentV - entryV) / entryV) * 100;
      const chg = currentV - entryV;
      netProfitStr = `${np >= 0 ? '+' : ''}${np.toFixed(2)}% (${chg >= 0 ? '+' : ''}$${chg.toFixed(2)})`;

      if (entry.tpArmed) {
        tpStr = `ARMED at peak ${entry.tpPeak.toFixed(1)}% (trail 1%)`;
      } else if (np >= 7) {
        tpStr = `reached +${np.toFixed(1)}% — arming next cycle`;
      } else {
        tpStr = np < 0 ? `not armed (need +7%)` : `not armed (need +${(7 - np).toFixed(1)}%)`;
      }
    }
  }

  await tg([
    `📊 Position Update #${entry.tokenId} (${entry.pool || '?'})`,
    `Status: ${statusStr}`,
    `IL: ${ilPct >= 0 ? '+' : ''}${ilPct.toFixed(2)}% | Net P&L: ${netProfitStr}`,
    `Fees: $0.00 (V4)`,
    `TP: ${tpStr}`,
  ].join('\n'));
}

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  const config = UC('lp');
  const isWatch = process.env.WATCH === '1';

  console.log(`Auto-close: ${AUTO_CLOSE_DRY ? 'DRY-RUN (AUTO_CLOSE_DRY=1)' : 'LIVE (AUTO_CLOSE_DRY=0)'}`);

  if (isWatch) {
    console.log(`Continuous monitoring every ${config.monitorIntervalMs}ms. Ctrl+C to stop.`);
    console.log('Periodic position report every 300s (5 min) to Telegram.');
    setInterval(() => {
      sendPeriodicReport(provider).catch(e => console.error('Periodic report error:', e.shortMessage || e.message));
    }, 300000);
    while (true) {
      try { await monitorOnce(provider, config); }
      catch (e) { console.error(`Monitor error: ${e.shortMessage || e.message}`); }
      await new Promise(r => setTimeout(r, config.monitorIntervalMs));
    }
  } else {
    await monitorOnce(provider, config);
  }
}

main().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });