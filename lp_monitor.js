import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, formatEther, formatUnits, AbiCoder, keccak256 } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_NFPM_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';
import { tg } from './telegram.js';
import { withdrawV3, withdrawV4 } from './lp_withdraw.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);

const { sqrt } = Math;

const AUTO_CLOSE_DRY = process.env.AUTO_CLOSE_DRY !== '0';
const FORCE_TRIGGER = process.env.FORCE_TRIGGER === '1';
const LIVE = process.env.DRY === '0' && process.env.PRIVATE_KEY;

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

function ilConcentrated(entryPrice, currentPrice, tickLower, tickUpper) {
  const r = currentPrice / entryPrice;
  const sqrtR = sqrt(r);
  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);

  if (currentPrice <= priceLower) return -(1 - 1 / r);
  if (currentPrice >= priceUpper) return -(r - 1);
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
    liquidity: formatUnits(pos.liquidity, 18),
    outOfRange,
    ilExceedsThreshold,
    shouldNotify: ilExceedsThreshold || outOfRange,
  };

  // AUTO-CLOSE: trigger if IL exceeds threshold + sanity passes, or FORCE_TRIGGER=1
  const shouldTrigger = (ilExceedsThreshold && pos.liquidity > 0n) || FORCE_TRIGGER;
  if (shouldTrigger) {
    const reason = FORCE_TRIGGER ? 'FORCE_TRIGGER=1' : `IL=${ilPct.toFixed(2)}% < -${threshold}%`;
    console.log(`>>> ${AUTO_CLOSE_DRY ? 'AKAN auto-close' : 'AUTO-CLOSING'} #${entry.tokenId} (${reason})`);

    if (AUTO_CLOSE_DRY) {
      await tg(`\u{1F514} LP Monitor — AUTO-CLOSE DRY\n` +
        `Position #${entry.tokenId} (${result.pool})\n` +
        `Trigger: ${reason}\n` +
        `AKAN di-close otomatis jika AUTO_CLOSE_DRY=0`).catch(() => {});
    } else if (LIVE) {
      const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
      await tg(`\u{1F534} AUTO-CLOSING position #${entry.tokenId}\nIL: ${ilPct.toFixed(2)}%`).catch(() => {});
      try {
        await withdrawV3(provider, wallet, tokenId, config);
        result.autoClosed = true;
        await tg(`\u{2705} AUTO-CLOSED #${entry.tokenId} (IL=${ilPct.toFixed(2)}% < -${threshold}%)\n` +
          `Lihat wallet untuk hasil withdraw.`).catch(() => {});
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
  try {
    const [, tick] = await stateView.getSlot0.staticCall(poolId);
    currentTick = Number(tick);
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
    posLiquidity: posLiq.toString(),
    outOfRange,
    ilExceedsThreshold,
    shouldNotify: ilExceedsThreshold || outOfRange,
  };

  // AUTO-CLOSE: trigger if IL exceeds threshold + position has liquidity, or FORCE_TRIGGER=1
  const shouldTrigger = (ilExceedsThreshold && posLiq > 0n) || FORCE_TRIGGER;
  if (shouldTrigger) {
    const reason = FORCE_TRIGGER ? 'FORCE_TRIGGER=1' : `IL=${ilPct.toFixed(2)}% < -${threshold}%`;
    console.log(`>>> ${AUTO_CLOSE_DRY ? 'AKAN auto-close' : 'AUTO-CLOSING'} V4 #${entry.tokenId} (${reason})`);

    if (AUTO_CLOSE_DRY) {
      await tg(`\u{1F514} LP Monitor — AUTO-CLOSE DRY (V4)\n` +
        `Position #${entry.tokenId} (${result.pool})\n` +
        `Trigger: ${reason}\n` +
        `AKAN di-close otomatis jika AUTO_CLOSE_DRY=0`).catch(() => {});
    } else if (LIVE) {
      const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
      await tg(`\u{1F534} AUTO-CLOSING V4 position #${entry.tokenId}\nIL: ${ilPct.toFixed(2)}%`).catch(() => {});
      try {
        await withdrawV4(provider, wallet, config, entry.tokenId);
        result.autoClosed = true;
        await tg(`\u{2705} AUTO-CLOSED V4 #${entry.tokenId} (IL=${ilPct.toFixed(2)}% < -${threshold}%)\n` +
          `Lihat wallet untuk hasil withdraw.`).catch(() => {});
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
        // FIX: posisi sudah tertutup/kosong BUKAN kegagalan sistem -- hapus dari
        // tracking, jangan hitung sebagai anyFail (cegah circuit breaker spam abadi)
        if (result?.error === 'liquidity zero' || result?.error === 'position burned or not found') {
          toRemove.push(entry);
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
          toRemove.push(entry);
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

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  const config = UC('lp');
  const isWatch = process.env.WATCH === '1';

  console.log(`Auto-close: ${AUTO_CLOSE_DRY ? 'DRY-RUN (AUTO_CLOSE_DRY=1)' : 'LIVE (AUTO_CLOSE_DRY=0)'}`);

  if (isWatch) {
    console.log(`Continuous monitoring every ${config.monitorIntervalMs}ms. Ctrl+C to stop.`);
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