import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Contract, Wallet, formatEther, formatUnits, AbiCoder, keccak256, parseEther } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_NFPM_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';
import { tg } from './telegram.js';
import { withdrawV3, withdrawV4, swapBackAfterWithdraw } from './lp_withdraw.js';
import { enrichPoolData, genericSwap, genericDeposit, detectPoolType } from './lp_auto_open.js';
import { computeTickRange, computeSingleSideWethRange, computeSingleSideTokenRange } from './lp_deposit.js';
import { getSqrtRatioAtTick, getAmountsForLiquidity, getEthUsdPrice, getTokenUsdPricesFromTick } from './v3_math.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);

const { sqrt } = Math;

const AUTO_CLOSE_DRY = process.env.AUTO_CLOSE_DRY !== '0';
const FORCE_TRIGGER = process.env.FORCE_TRIGGER === '1';
const LIVE = process.env.DRY === '0' && process.env.PRIVATE_KEY;

// ── SAFETY CHECK: AUTO_CLOSE_DRY must be explicitly set ──
// Insiden lalu: AUTO_CLOSE_DRY tidak pernah di-set, default diam-diam ke
// dry-run, posisi #541813 crash ke IL -68% tanpa auto-close. Jangan pernah
// membiarkan default diam-diam tanpa peringatan yang jelas.
const WARN_BOX = (t) => '='.repeat(t.length + 4) + '\n= ' + t + ' =\n' + '='.repeat(t.length + 4);
if (process.env.AUTO_CLOSE_DRY === undefined) {
  const warn = [
    '\n' + WARN_BOX('⚠️  AUTO_CLOSE_DRY TIDAK DI-SET DI .env  ⚠️'),
    '',
    '  Auto-close BERJALAN DALAM MODE DRY-RUN (tidak akan mengeksekusi).',
    '  Jika LP sedang live / ada dana, ini BISA MENYEBABKAN POSISI TIDAK TER-CLOSE',
    '  saat IL menembus threshold (insiden #541813 IL -68%).',
    '',
    '  SET DI .env:',
    '    AUTO_CLOSE_DRY=0   → LIVE auto-close',
    '    AUTO_CLOSE_DRY=1   → dry-run (eksplisit)',
    '='.repeat(72),
    ''
  ].join('\n');
  console.warn(warn);
} else {
  console.log(`Auto-close mode: ${AUTO_CLOSE_DRY ? 'DRY-RUN (AUTO_CLOSE_DRY=1)' : 'LIVE (AUTO_CLOSE_DRY=0)'}`);
}

// --- TP config constants (from user-config.json) ---
const TP_ARM_THRESHOLD = UC('lp.takeProfitArmPct') || 20;
const TP_TRAIL_DISTANCE = UC('lp.takeProfitTrailPct') || 5;
const DEFAULT_POSITION_VALUE_ETH = UC('lp.positionSizeEth') || 0.01;

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
      const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI.concat(['function ownerOf(uint256) view returns (address)']), provider);
      // If ownerOf reverts with "invalid token ID", position NFT is burned — definitely closed.
      // BUT a network/RPC error is NOT proof of closure — must fail-safe KEEP.
      let owner;
      try {
        owner = await nfpm.ownerOf(tokenId);
      } catch (e) {
        if (isRevertNotNetworkError(e)) return true; // genuine on-chain revert = burned
        console.warn(`  confirmPositionClosed V3 #${tokenId}: ownerOf FAILED (fail-safe KEEP) — ${(e?.shortMessage || e?.message || e).slice(0, 80)}`);
        return false; // RPC glitch/timeout — NEVER remove a possibly-live position
      }
      if (!owner) return true;
      // Owner exists — check liquidity directly
      const pos = await nfpm.positions.staticCall(tokenId);
      const closed = pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n;
      if (!closed) console.warn(`  confirmPositionClosed V3 #${tokenId}: liquidity=${pos.liquidity?.toString() ?? '?'} tokensOwed=${pos.tokensOwed0 ?? '?'}/${pos.tokensOwed1 ?? '?'} — NOT closed`);
      return closed;
    }
    if (dex === 'V4') {
      const nfpm = new Contract(V4_NFPM, ['function ownerOf(uint256) view returns (address)'], provider);
      let owner;
      try {
        owner = await nfpm.ownerOf(tokenId);
      } catch (e) {
        if (isRevertNotNetworkError(e)) return true; // genuine on-chain revert = burned
        console.warn(`  confirmPositionClosed V4 #${tokenId}: ownerOf FAILED (fail-safe KEEP) — ${(e?.shortMessage || e?.message || e).slice(0, 80)}`);
        return false; // RPC glitch/timeout — NEVER remove a possibly-live position
      }
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

// Distinguish a genuine on-chain revert (burned token → safe to treat as closed)
// from a network/RPC failure (must NOT remove a possibly-live position).
// FAIL-SAFE: ONLY a deterministic on-chain CALL_EXCEPTION proves burned.
// Anything else (network error, timeout, unknown) → false → KEEP position.
function isRevertNotNetworkError(e) {
  const code = e?.code;
  const msg = `${e?.shortMessage || ''} ${e?.message || ''} ${e?.error?.message || ''}`.toLowerCase();
  if (code === 'CALL_EXCEPTION') return true;              // on-chain revert = token burned
  if (/execution reverted|invalid token/i.test(msg)) return true;
  // network / RPC / unknown → fail-safe KEEP (never remove a possibly-live position)
  return false;
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
  // CRITICAL: warm the live ETH/USD cache FIRST. getTokenUsdPricesFromTick() →
  // getWethUsdPrice() is a SYNC cache-reader that NEVER fetches on its own — if
  // the cache is still null it silently falls back to $3000. For WETH pairs the
  // tick-based path below ALWAYS returns non-null, so the old code returned
  // before ever calling getEthUsdPrice(), inflating every WETH-paired position
  // value by ~1.6x (ETH now ~$1880) and arming take-profit on fake +60% gains.
  await getEthUsdPrice();
  // Try tick-based derivation first (fast, no external API)
  const tickPrices = getTokenUsdPricesFromTick(token0, token1, currentTick);
  if (tickPrices) return tickPrices;
  // Fallback: ETH price already warmed above; try DexScreener API for non-WETH pairs
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

// Get real-time uncollected fees via staticCall collect() — tokensOwed from
// positions() is stale until a transaction touches the position. This view-only
// call returns actual accrued fees without sending any transaction.
async function getRealTimeFeesV3(provider, tokenId) {
  try {
    const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, provider);
    const r = await nfpm.collect.staticCall({
      tokenId,
      recipient: '0x0000000000000000000000000000000000000001',
      amount0Max: (1n << 128n) - 1n,
      amount1Max: (1n << 128n) - 1n,
    });
    return { amount0: BigInt(r[0]), amount1: BigInt(r[1]) };
  } catch { return { amount0: 0n, amount1: 0n }; }
}

// Compute current USD value of a position from its live amounts.
// Export so lp_reconcile.js can estimate entryValueUsd for recovered positions
// (uses current price as the entry proxy — we don't know the original entry).
export async function computePositionUsdValue(provider, liquidity, sqrtPriceX96, tickLower, tickUpper, currentTick, tokensOwed0, tokensOwed1, token0, token1) {
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

  // Get real-time fees via staticCall (positions().tokensOwed is stale)
  const realFees = await getRealTimeFeesV3(provider, tokenId);
  const fee0 = realFees.amount0;
  const fee1 = realFees.amount1;

  // Fetch token symbols + decimals (not hardcoded 18 / 'ETH')
  let sym0 = '?', sym1 = '?', d0 = 18, d1 = 18;
  if (entry.token0) {
    try {
      const c0 = new Contract(entry.token0, ERC20_ABI, provider);
      const s = await c0.symbol().catch(() => null);
      if (s) { sym0 = s; d0 = await c0.decimals().catch(() => 18); }
    } catch {}
  }
  if (entry.token1) {
    try {
      const c1 = new Contract(entry.token1, ERC20_ABI, provider);
      const s = await c1.symbol().catch(() => null);
      if (s) { sym1 = s; d1 = await c1.decimals().catch(() => 18); }
    } catch {}
  }
  if (sym0 !== '?' && sym1 !== '?') poolSymbol = `${sym0}/${sym1}`;

  // Fee value in USD (like _reportV3 — uses actual decimals + USD prices)
  let feeValueUsd = 0;
  try {
    const prices = await getTokenUsdPrices(entry.token0 || pos.token0, entry.token1 || pos.token1, currentTick, sqrtPriceX96, provider);
    if (prices) {
      feeValueUsd = Number(formatUnits(fee0, d0)) * (prices.token0Usd || 0)
                  + Number(formatUnits(fee1, d1)) * (prices.token1Usd || 0);
    }
  } catch {}

  const ilPct = ilConcentrated(entryPrice, price, Number(pos.tickLower), Number(pos.tickUpper)) * 100;
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
      fee0, fee1,
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
    feeValueUsd,
    sym0, sym1,
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
  // `let` — merge-on-save below re-assigns state = fresh (reloads disk state so
  // mid-cycle deposits written by depositV3/depositV4/auto-open are not clobbered).
  let state = loadState();
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
      console.log(`  V3 #${result.tokenId}: IL=${result.ilPct.toFixed(2)}% fee=$${result.feeValueUsd.toFixed(2)} pool=${result.pool} liq=${result.liquidity.slice(0,8)} range=${rangePct}% [${statusIcon}]`);

      // Suppress generic notify if auto-close already sent its own message
      if (result.autoClosed || result.autoCloseFailed) {
        if (result.autoClosed) toRemove.push(entry);
      } else if (result.shouldNotify) {
        const notifyChg = Number(config.oorNotifyMinIlChangePct) || 5;
        const oldOor = entry.lastNotifiedOOR;
        entry.lastNotifiedOOR = result.outOfRange;
        let edgeTrigger = false;
        if (result.outOfRange && !oldOor) edgeTrigger = true;
        if (result.ilExceedsThreshold) {
          const ilBucket = Math.floor(result.ilPct / notifyChg) * notifyChg;
          if (entry.lastNotifiedILBucket === undefined || ilBucket < entry.lastNotifiedILBucket) {
            edgeTrigger = true;
            entry.lastNotifiedILBucket = ilBucket;
          }
        }
        if (!edgeTrigger) continue;
        const parts = [
          `\u{1F514} LP Monitor: ${result.pool} #${result.tokenId}`,
          `IL: ${result.ilPct.toFixed(2)}% (threshold: -${config.ilExitThresholdPct}%)`,
          `Fees earned: \$${result.feeValueUsd.toFixed(2)}`,
          `Entry: ${result.entryPrice.toFixed(8)} | Now: ${result.price.toFixed(8)}`,
        ];
        if (result.outOfRange) parts.push('\u{26A0}\u{FE0F} OUT OF RANGE');
        if (result.ilExceedsThreshold) parts.push('\u{26A0}\u{FE0F} IL exceeds threshold');
        await tg(parts.join('\n')).catch(() => {});
      }

      // Auto-rebalance: OOR ringan (belum mencapai SL)
      if (!result.autoClosed && !result.autoCloseFailed && result.shouldNotify) {
        const rebalanced = await tryRebalance(entry, result, provider);
        if (rebalanced && rebalanced.tokenId) {
          // Rebalance minted a NEW position (depositV3 already pushed it to state on disk).
          // Mark the OLD (now-withdrawn) entry for removal; the merge-on-save below
          // preserves the new position that depositV3 wrote.
          toRemove.push(entry);
        }
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
        const notifyChg = Number(config.oorNotifyMinIlChangePct) || 5;
        const oldOor = entry.lastNotifiedOOR;
        entry.lastNotifiedOOR = result.outOfRange;
        let edgeTrigger = false;
        if (result.outOfRange && !oldOor) edgeTrigger = true;
        if (result.ilExceedsThreshold) {
          const ilBucket = Math.floor(result.ilPct / notifyChg) * notifyChg;
          if (entry.lastNotifiedILBucket === undefined || ilBucket < entry.lastNotifiedILBucket) {
            edgeTrigger = true;
            entry.lastNotifiedILBucket = ilBucket;
          }
        }
        if (!edgeTrigger) continue;
        const parts = [
          `\u{1F514} LP Monitor: ${result.pool} #${result.tokenId}`,
          `IL: ${result.ilPct.toFixed(2)}% (threshold: -${config.ilExitThresholdPct}%)`,
          `Entry: ${result.entryPrice.toFixed(8)} | Now: ${result.price.toFixed(8)}`,
        ];
        if (result.outOfRange) parts.push(`\u{26A0}\u{FE0F} OUT OF RANGE`);
        if (result.ilExceedsThreshold) parts.push(`\u{26A0}\u{FE0F} IL exceeds threshold`);
        await tg(parts.join('\n')).catch(() => {});
      }

      // Auto-rebalance: OOR ringan V4
      if (!result.autoClosed && !result.autoCloseFailed && result.shouldNotify) {
        const rebalanced = await tryRebalance(entry, result, provider);
        if (rebalanced && rebalanced.tokenId) {
          // Mark the OLD (now-withdrawn) V4 entry for removal; the merge-on-save below
          // preserves the new V4 position that depositV4 wrote to disk.
          toRemove.push(entry);
        }
      }
    }
  }

  // Clean up auto-closed positions from state
  if (toRemove.length > 0) {
    state.positions = state.positions.filter(p => !toRemove.includes(p));
    console.log(`  Cleaned ${toRemove.length} auto-closed position(s) from state`);
  }

  // ── MERGE-ON-SAVE (anti data-loss) ──
  // depositV3/depositV4 (called during rebalance) AND auto-open processes write
  // new positions to lp_state.json via their OWN loadState/saveState. If we just
  // saveState(state) here with our stale in-memory copy, we CLOBBER those freshly
  // minted positions — leaving live dana untracked. So: reload fresh from disk,
  // overlay this cycle's in-memory runtime fields, and re-apply removals.
  try {
    const fresh = loadState();
    const removedIds = new Set(toRemove.map(p => `${p.dex}:${p.tokenId}`));
    // In-memory entries carry this cycle's runtime updates (tpArmed/tpPeak/
    // lastNotifiedOOR/_rebalanceOorSince/_lastRebalanceAt) — prefer them.
    const inMemMap = new Map();
    for (const p of state.positions) {
      if (removedIds.has(`${p.dex}:${p.tokenId}`)) continue;
      inMemMap.set(`${p.dex}:${p.tokenId}`, p);
    }
    const merged = [];
    const seen = new Set();
    // Keep every position that currently exists on disk (incl. new deposits written
    // by depositV3/depositV4/auto-open), minus ones removed this cycle.
    for (const p of (fresh.positions || [])) {
      const k = `${p.dex}:${p.tokenId}`;
      if (removedIds.has(k)) continue;
      merged.push(inMemMap.get(k) || p);
      seen.add(k);
    }
    // Any in-memory position missing from disk (paranoia) — keep it too.
    for (const [k, p] of inMemMap) {
      if (!seen.has(k)) { merged.push(p); seen.add(k); }
    }
    fresh.monitor = state.monitor;
    fresh.positions = merged;
    state = fresh;
  } catch (e) {
    console.warn(`  merge-on-save failed, writing stale state: ${e.shortMessage || e.message}`);
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
function formatLpDuration(ts) {
  if (!ts || typeof ts !== 'number' || ts <= 0) return 'unknown';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 0) return 'just now';
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${m}m`;
  return `${m}m`;
}

async function sendPeriodicReport(provider) {
  const state = loadState();
  if (!state.positions?.length) return;

  const sections = [];
  for (const entry of state.positions) {
    let section = null;
    try {
      if (entry.dex === 'V3') section = await _reportV3(provider, entry);
      else if (entry.dex === 'V4') section = await _reportV4(provider, entry);
    } catch (e) {
      console.error(`Periodic report error #${entry.tokenId}: ${e.shortMessage || e.message}`);
    }
    if (section) sections.push(section);
  }

  if (!sections.length) return;

  await tg([
    `📊 Position Report (${sections.length} aktif)`,
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n'));
}

async function _reportV3(provider, entry) {
  const tokenId = BigInt(entry.tokenId);
  const pos = await getV3Position(provider, tokenId);
  if (!pos || pos.liquidity === 0n) return;

  // Get real-time fees via staticCall (positions().tokensOwed is stale)
  const realFees = await getRealTimeFeesV3(provider, tokenId);
  const fee0 = realFees.amount0;
  const fee1 = realFees.amount1;

  let poolAddr;
  if (entry.token0 && entry.token1 && entry.fee != null) {
    try { poolAddr = await getV3PoolAddress(provider, entry.token0, entry.token1, entry.fee); } catch { return; }
  } else { return; }

  const t0 = new Contract(entry.token0, ERC20_ABI, provider);
  const t1 = new Contract(entry.token1, ERC20_ABI, provider);
  const [sym0, sym1] = await Promise.all([
    t0.symbol().catch(() => entry.token0.slice(0, 10)),
    t1.symbol().catch(() => entry.token1.slice(0, 10)),
  ]);
  const pairLabel = `${sym0}/${sym1}`;

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
      fee0, fee1,
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
        const f0 = Number(formatUnits(fee0, d0)) * (prices.token0Usd || 0);
        const f1 = Number(formatUnits(fee1, d1)) * (prices.token1Usd || 0);
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

  const durStr = formatLpDuration(entry.ts);
  return [
    `#${entry.tokenId} (${pairLabel}) — ${durStr}`,
    `Status: ${statusStr}`,
    `IL: ${ilPct >= 0 ? '+' : ''}${ilPct.toFixed(2)}% | Net P&L: ${netProfitStr}`,
    `Fees: ${feeStr} | TP: ${tpStr}`,
  ].join('\n');
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
  const t0 = new Contract(token0, ERC20_ABI, provider);
  const t1 = new Contract(token1, ERC20_ABI, provider);
  const [sym0, sym1] = await Promise.all([
    t0.symbol().catch(() => token0.slice(0, 10)),
    t1.symbol().catch(() => token1.slice(0, 10)),
  ]);
  const pairLabel = `${sym0}/${sym1}`;
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

  const durStr = formatLpDuration(entry.ts);
  return [
    `#${entry.tokenId} (${pairLabel}) — ${durStr}`,
    `Status: ${statusStr}`,
    `IL: ${ilPct >= 0 ? '+' : ''}${ilPct.toFixed(2)}% | Net P&L: ${netProfitStr}`,
    `Fees: $0.00 (V4) | TP: ${tpStr}`,
  ].join('\n');
}

// ===== AUTO-REBALANCE (re-center OOR position tanpa trigger SL) =====
async function tryRebalance(entry, result, provider) {
  const config = UC('lp');
  if (!config.enableAutoRebalance) return false;

  if (!result.outOfRange) {
    if (entry._rebalanceOorSince) { delete entry._rebalanceOorSince; console.log(`  [rebalance] #${entry.tokenId} kembali IN RANGE — reset`); }
    return false;
  }

  const threshold = Number(config.ilExitThresholdPct) || 40;
  const ilSafeLimit = -(threshold * 0.5);
  if (result.ilPct <= ilSafeLimit) {
    console.log(`  [rebalance] #${entry.tokenId}: IL ${result.ilPct.toFixed(2)}% <= ${ilSafeLimit}% (50% threshold) — terlalu dekat SL`);
    return false;
  }

  if (!entry._rebalanceOorSince) {
    entry._rebalanceOorSince = Date.now();
    console.log(`  [rebalance] #${entry.tokenId}: first OOR — rebalance after ${config.rebalanceMinOorMinutes || 10}min sustained`);
    return false;
  }

  const minOorMin = Number(config.rebalanceMinOorMinutes) || 10;
  const oorDuration = (Date.now() - entry._rebalanceOorSince) / 60000;
  if (oorDuration < minOorMin) {
    console.log(`  [rebalance] #${entry.tokenId}: OOR ${oorDuration.toFixed(1)}min < ${minOorMin}min — waiting`);
    return false;
  }

  const cdHours = Number(config.rebalanceCooldownHours) || 2;
  if (entry._lastRebalanceAt) {
    const elapsed = (Date.now() - entry._lastRebalanceAt) / 3600000;
    if (elapsed < cdHours) {
      console.log(`  [rebalance] #${entry.tokenId}: cooldown ${elapsed.toFixed(1)}h < ${cdHours}h — skip`);
      return false;
    }
  }

  // ── EXECUTE ──
  const execProv = await (process.env.LP_EXEC_RPC_URL
    ? makeProvider('LP_EXEC_RPC_URL')
    : makeProvider('LP_MONITOR_RPC_URL')).catch(() => null);
  if (!execProv) { console.log('  [rebalance] no provider'); return false; }

  const wallet = AUTO_CLOSE_DRY || !process.env.PRIVATE_KEY ? null : new Wallet(process.env.PRIVATE_KEY, execProv);
  const posSizeEth = UC('lp.positionSizeEth') || 0.01;
  const amountEth = parseEther(String(posSizeEth));
  const symLabel = `${result.pool || '?'}`;
  const rangeOld = `[${entry.tickLower}, ${entry.tickUpper}]`;
  const mode = config.depositMode || 'in-range';
  const tickSpacing = entry.tickSpacing || 60; // fallback
  const token0Addr = entry.token0 || entry.currency0;
  const token1Addr = entry.token1 || entry.currency1;
  const hasWeth = token0Addr?.toLowerCase() === WETH_ADDR_MONITOR || token1Addr?.toLowerCase() === WETH_ADDR_MONITOR;
  const wethIsToken0 = token0Addr?.toLowerCase() === WETH_ADDR_MONITOR;

  // ── COMPOSITION-AWARE REOPEN ──
  // Estimate dominant side from tick position vs old range (deterministic, works in dry-run).
  // Above range → 100% token1; below range → 100% token0.
  const aboveOld = result.currentTick > (entry.tickUpper || 0);
  const belowOld = result.currentTick < (entry.tickLower || 0);
  const estDominantToken = aboveOld ? token1Addr : (belowOld ? token0Addr : null);
  const estPct = (aboveOld || belowOld) ? 1 : 0.5;

  let strategy;
  if (estDominantToken?.toLowerCase() === WETH_ADDR_MONITOR && estPct >= 0.9) strategy = '3a-WETH (reopen WETH, no swap)';
  else if (estDominantToken && estPct >= 0.9) strategy = '3b-TOKEN (single-side-token, no swap-back)';
  else strategy = '5-MIXED (full swap-back)';

  const depMode = strategy.startsWith('3b')
    ? 'single-side-token'
    : (mode === 'in-range' ? 'in-range' : 'single-side-eth');

  const symPct = Number(config.rangeSymmetricPct) || 30;
  const tokenAddr = depMode === 'single-side-token'
    ? (estDominantToken || (wethIsToken0 ? token1Addr : token0Addr))
    : null;
  let newTickRange;
  if (depMode === 'single-side-token' && token0Addr && token1Addr && tokenAddr) {
    newTickRange = computeSingleSideTokenRange(result.currentTick, symPct, tickSpacing, token0Addr, token1Addr, tokenAddr);
  } else if (depMode === 'single-side-eth' && token0Addr && token1Addr) {
    newTickRange = computeSingleSideWethRange(result.currentTick, symPct, tickSpacing, token0Addr, token1Addr, WETH_ADDR_MONITOR);
  } else {
    newTickRange = computeTickRange(result.currentTick, symPct, tickSpacing);
  }
  const rangeNew = `[${newTickRange.tickLower}, ${newTickRange.tickUpper}]`;

  const msg = `🔄 AUTO-REBALANCE #${entry.tokenId}: range lama ${rangeOld} -> range baru ${rangeNew}, harga sekarang tick=${result.currentTick}, IL sebelum=${result.ilPct.toFixed(2)}%\nStrategy: ${strategy}`;

  if (!wallet) {
    console.log(`  [rebalance DRY] ${msg}`);
    await tg(msg).catch(() => {});
    entry._lastRebalanceAt = Date.now();
    return true;
  }

  console.log(`  [rebalance] ${msg}`);

  // Step 1: Tutup posisi lama — skipSwapBack=true KHUSUS untuk rebalance:
  // jangan swap-back di dalam withdraw, biarkan token apa adanya di wallet
  // supaya Step 4 bisa baca komposisi ASLI (sebelum keputusan swap).
  let closeOk = false;
  try {
    if (entry.dex === 'V3') {
      const wd = await withdrawV3(execProv, wallet, BigInt(entry.tokenId), config, true);
      closeOk = wd && !wd._burnFailed;
    } else if (entry.dex === 'V4') {
      const wd = await withdrawV4(execProv, wallet, config, entry.tokenId, true);
      closeOk = wd && !wd._burnFailed;
    }
  } catch (e) {
    console.log(`  [rebalance] close FAILED: ${e.shortMessage || e.message}`);
    await tg(`❌ AUTO-REBALANCE FAILED — close #${entry.tokenId}: ${e.shortMessage || e.message}`).catch(() => {});
    return false;
  }

  if (!closeOk) {
    console.log(`  [rebalance] close FAILED (unknown)`);
    await tg(`❌ AUTO-REBALANCE FAILED — close #${entry.tokenId}: unknown error`).catch(() => {});
    return false;
  }

  // Step 2: Dapatkan poolAddr dari posisi
  let poolAddr;
  try {
    if (entry.dex === 'V3' && entry.token0 && entry.token1 && entry.fee != null) {
      poolAddr = await getV3PoolAddress(execProv, entry.token0, entry.token1, entry.fee);
    } else if (entry.dex === 'V4' && entry.poolId) {
      poolAddr = '0x' + entry.poolId.slice(2, 42).toLowerCase();
    } else {
      console.log('  [rebalance] cannot determine pool address');
      await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI pool address tidak dikenal`).catch(() => {});
      return false;
    }
  } catch (e) {
    console.log(`  [rebalance] pool lookup FAILED: ${e.shortMessage || e.message}`);
    await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI pool lookup gagal`).catch(() => {});
    return false;
  }

  // Step 3: Enrich pool data untuk deposit
  const poolLike = { pairAddress: poolAddr, baseToken: { address: token0Addr }, quoteToken: { address: token1Addr } };
  const poolInfo = await enrichPoolData(poolLike, execProv);
  if (!poolInfo) {
    console.log('  [rebalance] enrichPoolData failed');
    await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI pool enrichment gagal`).catch(() => {});
    return false;
  }

  // Override range dengan yang baru dihitung
  poolInfo.tickLower = newTickRange.tickLower;
  poolInfo.tickUpper = newTickRange.tickUpper;

  // ── Step 4: COMPOSITION-AWARE REOPEN ──
  // Baca komposisi wallet NYATA setelah withdraw (bukan prediksi tick).
  // 3a: WETH dominan → old flow (swap ke WETH, deposit WETH)
  // 3b: TOKEN dominan → single-side-token (skip swap-back, deposit token langsung)
  // 5 : campur 10-90% → old fallback (full swap-back)
  const t0c = new Contract(token0Addr, ERC20_ABI, execProv);
  const t1c = new Contract(token1Addr, ERC20_ABI, execProv);
  const [bal0, bal1] = await Promise.all([t0c.balanceOf(wallet.address), t1c.balanceOf(wallet.address)]);
  const dec0 = poolInfo.decimals0 ?? 18;
  const dec1 = poolInfo.decimals1 ?? 18;
  const usdPrices = await getTokenUsdPrices(token0Addr, token1Addr, result.currentTick, 0, execProv);
  const usd0 = usdPrices ? (Number(bal0) / 10 ** dec0) * usdPrices.token0Usd : 0;
  const usd1 = usdPrices ? (Number(bal1) / 10 ** dec1) * usdPrices.token1Usd : 0;
  const totalUsd = usd0 + usd1;
  const wethUsd = wethIsToken0 ? usd0 : usd1;
  const wethPct = totalUsd > 0 ? wethUsd / totalUsd : 0.5;
  console.log(`  [rebalance] komposisi aktual: ${(usd0 || 0).toFixed(2)}$ (token0) + ${(usd1 || 0).toFixed(2)}$ (token1) → WETH ${(wethPct * 100).toFixed(1)}%`);

  let stratLabel;
  if (hasWeth && wethPct >= 0.9) stratLabel = '3a-WETH (old flow)';
  else if (wethPct <= 0.1 || !hasWeth) stratLabel = '3b-TOKEN (single-side-token, skip swap-back)';
  else stratLabel = '5-MIXED (full swap-back)';
  console.log(`  [rebalance] strategy: ${stratLabel}`);

  const dominantIsWeth = wethPct >= 0.9 && hasWeth;

  // 3b: deposit token langsung, TANPA swap apapun
  if (!dominantIsWeth) {
    const dominantToken = usd0 >= usd1 ? token0Addr : token1Addr;
    const depConfig = { ...config, depositMode: 'single-side-token', singleSideToken: dominantToken };
    poolInfo.tickLower = newTickRange.tickLower;
    poolInfo.tickUpper = newTickRange.tickUpper;
    const position = await genericDeposit(poolInfo, amountEth, execProv, wallet, depConfig);
    if (!position) {
      console.log('  [rebalance] deposit 3b failed setelah withdraw');
      await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI deposit 3b gagal — dana di wallet, next cycle`).catch(() => {});
      return false;
    }
    entry._lastRebalanceAt = Date.now();
    await tg(`✅ ${msg}\nStrategy: ${stratLabel}\n→ Token ID baru: <code>${position.tokenId}</code>`).catch(() => {});
    console.log(`  [rebalance] SUCCESS 3b: #${entry.tokenId} -> #${position.tokenId}`);
    return position; // return new position so monitor can update state tracking
  }

  // 5 (mixed): swap-back penuh dulu → konsolidasi ke ETH/WETH
  if (wethPct < 0.9) {
    const sb = await swapBackAfterWithdraw(execProv, wallet, [token0Addr, token1Addr], config, true).catch(() => null);
    console.log(`  [rebalance] swap-back mixed: ${sb?.skipped ? 'skipped' : sb?.failed?.length ? 'partial' : 'ok'}`);
  }

  // 3a + 5: old flow — swap + deposit
  const swapResult = await genericSwap(poolInfo, amountEth, execProv, wallet, config);
  if (!swapResult) {
    console.log('  [rebalance] swap failed setelah close');
    await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI swap gagal — dana di wallet, next cycle`).catch(() => {});
    return false;
  }

  const position = await genericDeposit(poolInfo, amountEth, execProv, wallet, config);
  if (!position) {
    console.log('  [rebalance] deposit failed setelah swap');
    await tg(`⚠️ AUTO-REBALANCE PARTIAL: closed #${entry.tokenId} TAPI deposit gagal — dana di wallet, next cycle`).catch(() => {});
    return false;
  }

  entry._lastRebalanceAt = Date.now();
  await tg(`✅ ${msg}\nStrategy: ${stratLabel}\n→ Token ID baru: <code>${position.tokenId}</code>`).catch(() => {});
  console.log(`  [rebalance] SUCCESS: #${entry.tokenId} -> #${position.tokenId}`);
  return position; // return new position so monitor can update state tracking
}

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  const config = UC('lp');
  const isWatch = process.env.WATCH === '1';

  if (isWatch) {
    console.log(`Continuous monitoring every ${config.monitorIntervalMs}ms. Ctrl+C to stop.`);
    const reportIntervalSec = Math.round((UC('lp.periodicReportIntervalMs') || 300000) / 1000);
    console.log(`Periodic position report every ${reportIntervalSec}s (${Math.round(reportIntervalSec/60)} min) to Telegram.`);
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

// Only auto-execute if this is the main module (not imported by lp_reconcile.js)
const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(import.meta.url);
if (isMain) {
  main().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
}