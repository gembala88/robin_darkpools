// lp_auto_open.js — Generic auto-open system for LP pools
// Phase 1: AUTO_OPEN_DRY=1 only (no real execution)
//
// Architecture:
//   genericSwap(poolInfo, amountEth)   — swap to get paired tokens
//   genericDeposit(poolInfo, amountEth) — create LP position
//   enrichPoolData(po)    — add on-chain token0/token1/fee/decimals
//   checkAutoOpenConditions(po) — all 5 gates
//   autoOpenDryRun(po)    — log + TG notification

import 'dotenv/config';
import { Contract } from 'ethers';
import fs from 'node:fs';
import { makeProvider } from './provider.js';
import { V3 } from './config.js';
import { ERC20_ABI } from './abis.js';
import { tgScreener } from './telegram.js';

const AUTO_OPEN_DRY = 1; // Phase 1: ALWAYS dry-run, cannot be disabled
const LP_STATE_FILE = new URL('./lp_state.json', import.meta.url);

// ===== HELPERS =====

function loadLpState() {
  try { return JSON.parse(fs.readFileSync(LP_STATE_FILE, 'utf8')); } catch { return { positions: [] }; }
}

async function readDecimals(addr, provider) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return 18;
  try {
    const t = new Contract(addr, ERC20_ABI, provider);
    return Number(await t.decimals());
  } catch { return 18; }
}

// ===== ON-CHAIN POOL TYPE DETECTION =====
// Tries token0() on pool address. If it succeeds with valid address,
// the pool has a contract = V3. If it fails/reverts = V4 (logical pool
// in PoolManager, not a deployed contract).
export async function detectPoolType(poolAddr, provider) {
  try {
    const pool = new Contract(poolAddr, ['function token0() view returns (address)'], provider);
    const t0 = await pool.token0();
    if (t0 && t0 !== '0x0000000000000000000000000000000000000000') return 'V3';
  } catch {}
  return 'V4';
}

// ===== ON-CHAIN POOL ENRICHMENT =====
// Adds token0/token1 ordering, fee, tickSpacing, decimals from chain.
// Detects V3 vs V4 on-chain (not from DexScreener labels).
export async function enrichPoolData(po, provider) {
  if (!provider) provider = await makeProvider('LP_SCREENER_RPC_URL');

  const poolAddr = po.pairAddress;
  const dexType = await detectPoolType(poolAddr, provider);

  if (dexType === 'V3') {
    try {
      const pool = new Contract(poolAddr, [
        'function token0() view returns (address)',
        'function token1() view returns (address)',
        'function fee() view returns (uint24)',
      ], provider);
      const [token0, token1, fee] = await Promise.all([
        pool.token0(), pool.token1(), pool.fee(),
      ]);
      const factory = new Contract(V3.factory, ['function feeAmountTickSpacing(uint24) view returns (int24)'], provider);
      const tickSpacing = Number(await factory.feeAmountTickSpacing(fee));
      const [d0, d1] = await Promise.all([
        readDecimals(token0, provider),
        readDecimals(token1, provider),
      ]);
      return {
        dex: 'V3', token0, token1, fee, tickSpacing,
        decimals0: d0, decimals1: d1, poolAddr,
      };
    } catch (err) {
      console.warn(`  enrichPoolData V3 FAILED ${poolAddr.slice(0, 14)}: ${err.shortMessage || err.message}`);
      return null;
    }
  }

  // V4 — cannot determine fee/tickSpacing from DexScreener alone in Phase 1
  console.warn(`  enrichPoolData V4 ${poolAddr.slice(0, 14)}: partial (fee/tickSpacing unknown)`);
  return {
    dex: 'V4',
    currency0: po.baseToken?.address,
    currency1: po.quoteToken?.address,
    poolAddr,
    partial: true,
  };
}

// ===== TREND HISTORY =====
// Stores TVL/volume snapshots per pool (max 12 = 1hr at 5-min cycles)
const MAX_HISTORY = 12;

export function recordTrendSnapshot(po) {
  if (!po.trendHistory) po.trendHistory = [];
  po.trendHistory.push({
    time: Date.now(),
    tvlUsd: po.tvlUsd || 0,
    volume24h: po.volume24h || 0,
  });
  if (po.trendHistory.length > MAX_HISTORY) {
    po.trendHistory = po.trendHistory.slice(-MAX_HISTORY);
  }
}

// Linear regression slope on TVL from LAST 4 entries only,
// returns % change per cycle. Using only last 4 avoids old
// history masking recent declines.
export function computeTrend(po) {
  const h = po.trendHistory;
  if (!h || h.length < 4) return { direction: 'neutral', slopePct: 0, reason: `< 4 data points` };

  // Use only the most recent 4 entries
  const recent = h.slice(-4);
  const N = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  const meanY = recent.reduce((s, p) => s + p.tvlUsd, 0) / N;
  if (meanY === 0) return { direction: 'neutral', slopePct: 0, reason: 'zero TVL' };

  for (let i = 0; i < N; i++) {
    sumX += i;
    sumY += recent[i].tvlUsd;
    sumXY += i * recent[i].tvlUsd;
    sumX2 += i * i;
  }
  const slope = (N * sumXY - sumX * sumY) / (N * sumX2 - sumX * sumX);
  const slopePct = (slope / meanY) * 100;

  let direction = 'flat';
  if (slopePct > 2.0) direction = 'up';
  else if (slopePct < -2.0) direction = 'down';

  return { direction, slopePct: Math.round(slopePct * 100) / 100 };
}

// ===== GOVERNANCE CHECK =====
// Mirrors lp_deposit.js rules: max positions + token dedup
function checkGovernance(uniqueToken) {
  const lpState = loadLpState();
  const positions = lpState.positions || [];
  const MAX = Number(process.env.MAX_LP_POSITIONS || 3);

  if (positions.length >= MAX) {
    return { pass: false, reason: `max positions (${positions.length}/${MAX})` };
  }

  const STABLE = new Set([
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
  ]);

  const used = new Set();
  for (const pos of positions) {
    if (pos.dex === 'V3') {
      if (pos.token0 && !STABLE.has(pos.token0.toLowerCase())) used.add(pos.token0.toLowerCase());
      if (pos.token1 && !STABLE.has(pos.token1.toLowerCase())) used.add(pos.token1.toLowerCase());
    } else if (pos.dex === 'V4') {
      if (pos.currency0 && !STABLE.has(pos.currency0.toLowerCase())) used.add(pos.currency0.toLowerCase());
      if (pos.currency1 && !STABLE.has(pos.currency1.toLowerCase())) used.add(pos.currency1.toLowerCase());
    }
  }

  if (uniqueToken && used.has(uniqueToken.toLowerCase())) {
    return { pass: false, reason: 'token already in existing position' };
  }

  return { pass: true };
}

// ===== AUTO-OPEN CONDITIONS =====
// Gates:
//   1. Trend growth (replaces old score >= 60):
//      - trend must be UP (linear regression, >2% per cycle)
//      - score >= 40 (minCandidateScore) — token dengan trend naik TAPI skor
//        sedang tetap boleh lolos
//   2. HHI done and < 2500
//   3. GMGN done and clean
//   4. TVL >= $100k
//   5. Governance
export async function checkAutoOpenConditions(po) {
  if (AUTO_OPEN_DRY !== 1) return { pass: false, reason: 'auto-open disabled in config' };

  // Gate 1: Growth trend (replaces score >= 60)
  const trend = computeTrend(po);
  if (trend.direction !== 'up') return { pass: false, reason: `trend ${trend.direction} (${trend.slopePct}%/cycle) — need UP` };
  if ((po.score || 0) < 40) return { pass: false, reason: `score ${po.score} < 40` };

  // Gate 2: HHI done and < 2500
  if (!po.hhiData || po.hhiData.hhi === undefined) return { pass: false, reason: 'HHI not checked' };
  if (po.hhiData.hhi >= 2500) return { pass: false, reason: `HHI ${po.hhiData.hhi} >= 2500` };

  // Gate 3: GMGN done and clean
  if (!po.gmgnChecked) return { pass: false, reason: 'GMGN not checked' };
  if (po.gmgnFlags && po.gmgnFlags.length > 0) return { pass: false, reason: `GMGN flagged: ${po.gmgnFlags.join(', ')}` };

  // Gate 4: TVL >= $20k (trend gate is primary filter, not TVL size)
  if ((po.tvlUsd || 0) < 20000) return { pass: false, reason: `TVL $${(po.tvlUsd || 0).toLocaleString()} < $20k` };

  // Gate 5: Governance
  const uniqueToken = po.baseToken?.address;
  const gov = checkGovernance(uniqueToken);
  if (!gov.pass) return { pass: false, reason: `governance: ${gov.reason}` };

  return { pass: true };
}

// ===== DRY-RUN NOTIFICATION =====
export async function autoOpenDryRun(po, provider) {
  if (AUTO_OPEN_DRY !== 1) return;

  const b = po.baseToken;
  const q = po.quoteToken;

  // Detect pool type on-chain (not from DexScreener labels)
  let dexType = '?';
  if (provider && po.pairAddress) {
    try { dexType = await detectPoolType(po.pairAddress, provider); } catch {}
  }
  const sym = `${b?.symbol || '?'}/${q?.symbol || '?'} (${dexType})`;
  const trend = computeTrend(po);

  const msg = [
    `⚡ <b>AUTO-OPEN (DRY)</b> — ${sym}`,
    ``,
    `Token: <code>${b?.address || '?'}</code>`,
    `Pool: <code>${po.pairAddress}</code>`,
    ``,
    `🏅 Score: ${po.score}/100`,
    `💰 TVL: $${(po.tvlUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `📈 Trend: ${trend.direction === 'up' ? 'RISING' : trend.direction === 'down' ? 'DECLINING' : 'FLAT'} (${trend.slopePct}%/cycle)`,
    `📊 HHI: ${po.hhiData?.hhi}`,
    `✅ GMGN: clean`,
    `✅ Governance: OK`,
    ``,
    `<b>🔶 DRY — akan auto-open ${sym}</b>`,
  ].join('\n');

  console.log(`\n>>> AUTO-OPEN (DRY): ${sym}`);
  console.log(`    pool=${po.pairAddress}  score=${po.score}  tvl=$${(po.tvlUsd || 0).toLocaleString()}  hhi=${po.hhiData?.hhi}  trend=${trend.direction}(${trend.slopePct}%/cyc)  gmgn=clean  gov=OK`);

  await tgScreener(msg).catch(() => {});
}

// ===== GENERIC SWAP (Phase 1: DRY only) =====
// poolInfo: { dex, token0, token1, fee, tickSpacing, decimals0, decimals1, poolAddr }
export async function genericSwap(poolInfo, amountEth, provider) {
  console.log(`\n=== genericSwap (DRY) — ${poolInfo.dex} pool ${poolInfo.poolAddr.slice(0, 14)}...`);
  console.log(`  Would swap ${amountEth} ETH → tokens for LP position`);
  if (poolInfo.dex === 'V3') {
    console.log(`  token0=${poolInfo.token0} (${poolInfo.decimals0}d)`);
    console.log(`  token1=${poolInfo.token1} (${poolInfo.decimals1}d)`);
    console.log(`  fee=${poolInfo.fee}  tickSpacing=${poolInfo.tickSpacing}`);
  } else {
    console.log(`  currency0=${poolInfo.currency0}`);
    console.log(`  currency1=${poolInfo.currency1}`);
    if (poolInfo.partial) console.log(`  (partial V4 data — fee/tickSpacing unknown)`);
  }
  console.log(`  [DRY] no swap executed.`);
  return null;
}

// ===== GENERIC DEPOSIT (Phase 1: DRY only) =====
// poolInfo: same as genericSwap
export async function genericDeposit(poolInfo, amountEth, provider) {
  console.log(`\n=== genericDeposit (DRY) — ${poolInfo.dex} pool ${poolInfo.poolAddr.slice(0, 14)}...`);
  console.log(`  Would deposit ~${amountEth} ETH worth into LP position`);
  if (poolInfo.dex === 'V3') {
    console.log(`  token0=${poolInfo.token0} (${poolInfo.decimals0}d)`);
    console.log(`  token1=${poolInfo.token1} (${poolInfo.decimals1}d)`);
    console.log(`  fee=${poolInfo.fee}  tickSpacing=${poolInfo.tickSpacing}`);
  } else {
    console.log(`  currency0=${poolInfo.currency0}`);
    console.log(`  currency1=${poolInfo.currency1}`);
    if (poolInfo.partial) console.log(`  (partial V4 data — fee/tickSpacing unknown)`);
  }
  console.log(`  [DRY] no deposit executed.`);
  return null;
}
