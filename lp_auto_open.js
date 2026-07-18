// lp_auto_open.js — Generic auto-open system for LP pools
// Phase 1: AUTO_OPEN_DRY=1 (default, user review required before setting 0)
// Phase 2: AUTO_OPEN_DRY=0 + real execution (genericSwap + genericDeposit)
//
// Architecture:
//   genericSwap(poolInfo, amountEth)   — swap to get paired tokens
//   genericDeposit(poolInfo, amountEth) — create LP position
//   enrichPoolData(po)    — add on-chain token0/token1/fee/decimals
//   checkAutoOpenConditions(po) — all 5 gates
//   autoOpenDryRun(po)    — log + TG notification (Phase 1)
//   autoOpenExecute(po)   — execute swap + deposit (Phase 2)

import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, formatUnits, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, NATIVE, UC } from './config.js';
import { ERC20_ABI, V3_SWAP_ROUTER_ABI, V3_QUOTERV2_ABI, V3_NFPM_ABI, V4_NFPM_ABI } from './abis.js';
import { tgScreener } from './telegram.js';
import { depositV3, depositV4, loadState as loadLpState, saveState as saveLpState } from './lp_deposit.js';

const AUTO_OPEN_DRY = 0; // Phase 2: real execution after user review

// Trusted known tokens for swap routing
const WETH_ADDR = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG_ADDR = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const WETH_ABI = [
  'function deposit() payable',
  'function withdraw(uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// ===== HELPERS =====

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
// Sanity filter: rejects TVL jumps > 50% vs previous snapshot (DexScreener
// glitch guard — observed $434k→$177k in 25min while on-chain was stable).
const MAX_HISTORY = 12;

export function recordTrendSnapshot(po) {
  if (!po.trendHistory) po.trendHistory = [];
  const newTvl = po.tvlUsd || 0;
  const prev = po.trendHistory.length > 0 ? po.trendHistory[po.trendHistory.length - 1].tvlUsd : 0;

  // Sanity filter: clamp > 50% change from previous snapshot (DexScreener glitch guard)
  if (prev > 0 && newTvl > 0) {
    const change = Math.abs(newTvl - prev) / prev;
    if (change > 0.5) {
      const clamped = Math.round(prev * (1 + Math.sign(newTvl - prev) * 0.5));
      console.log(`  [TVL GLITCH] ${po.baseToken?.symbol || '?'}: $${prev}→$${newTvl} (${(change*100).toFixed(0)}%) — clamped to $${clamped}`);
      po.trendHistory.push({ time: Date.now(), tvlUsd: clamped, volume24h: po.volume24h || 0, glitch: true });
      if (po.trendHistory.length > MAX_HISTORY) po.trendHistory = po.trendHistory.slice(-MAX_HISTORY);
      return;
    }
  }

  po.trendHistory.push({
    time: Date.now(),
    tvlUsd: newTvl,
    volume24h: po.volume24h || 0,
  });
  if (po.trendHistory.length > MAX_HISTORY) {
    po.trendHistory = po.trendHistory.slice(-MAX_HISTORY);
  }
}

// Linear regression slope on TVL from LAST 4 NON-GLITCH entries,
// returns % change per cycle. Glitch entries (DexScreener spikes > 50%)
// are excluded to avoid false trends from bad data.
export function computeTrend(po) {
  const h = po.trendHistory;
  if (!h || h.length < 4) return { direction: 'neutral', slopePct: 0, reason: `< 4 data points` };

  // Use last 4 non-glitch entries
  const clean = h.filter(e => !e.glitch);
  const recent = clean.slice(-4);
  if (recent.length < 4) return { direction: 'neutral', slopePct: 0, reason: `< 4 non-glitch points` };
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
  // Gate 1: Growth trend (replaces score >= 60)
  const trend = computeTrend(po);
  if (trend.direction !== 'up') return { pass: false, reason: `trend ${trend.direction} (${trend.slopePct}%/cycle) — need UP` };
  if ((po.score || 0) < 35) return { pass: false, reason: `score ${po.score} < 35` };

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

// ===== SWAP HELPERS =====

// Get WETH9 address from router (or use known constant)
async function getWethAddress(provider) {
  try {
    const router = new Contract(V3.swapRouter02, ['function WETH9() view returns (address)'], provider);
    return await router.WETH9();
  } catch { return WETH_ADDR; }
}

// Wrap ETH → WETH
async function wrapEth(wallet, weth, amount) {
  const wethBal = await weth.balanceOf(wallet.address);
  if (wethBal >= amount) { console.log(`  WETH balance sufficient (${formatEther(wethBal)})`); return; }
  const needed = amount - wethBal;
  console.log(`  Wrapping ${formatEther(needed)} ETH → WETH`);
  const tx = await weth.deposit({ value: needed });
  const rc = await tx.wait();
  console.log(`  Wrap tx: ${tx.hash} (${rc.status === 1 ? 'OK' : 'FAIL'})`);
}

// Approve spender for token
async function approveToken(token, spender, amount, wallet, label) {
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance >= amount) { console.log(`  ${label} allowance OK`); return; }
  console.log(`  Approving ${label} for ${spender.slice(0, 10)}...`);
  const tx = await token.approve.populateTransaction(spender, MaxUint256);
  const sent = await wallet.sendTransaction(tx);
  await sent.wait();
  console.log(`  Approve tx: ${sent.hash}`);
}

// Try swap on a specific fee tier, returns amountOut or null
async function trySwapOnFee(router, quoter, tokenIn, tokenOut, amountIn, feeTier, wallet, provider) {
  try {
    const [expected] = await quoter.quoteExactInputSingle.staticCall([tokenIn, tokenOut, amountIn, feeTier, 0]);
    if (expected === 0n) return null;
    const slippagePct = BigInt(UC('lp.slippagePct') || 1);
    const minOut = expected - (expected * slippagePct) / 100n;
    console.log(`  Fee ${feeTier}: quote ${formatEther(amountIn)} → ${formatEther(expected)} (min ${formatEther(minOut)})`);
    const params = [tokenIn, tokenOut, feeTier, wallet.address, amountIn, minOut, 0n];
    const pop = await router.exactInputSingle.populateTransaction(params);
    const tx = await wallet.sendTransaction(pop);
    const rc = await tx.wait();
    if (rc.status === 1) {
      console.log(`  Swap OK: ${tx.hash}`);
      return expected;
    }
    return null;
  } catch (e) {
    const msg = e.shortMessage || e.message || '';
    if (msg.includes('insufficient liquidity') || msg.includes('STF')) return null;
    console.log(`  Fee ${feeTier}: ${msg.slice(0, 60)}`);
    return null;
  }
}

// Discover working fee tier for swap, returns amountOut or null
async function swapWithFeeDiscovery(router, quoter, tokenIn, tokenOut, amountIn, wallet, provider) {
  const TIERS = [10000, 3000, 500, 100, 10000];
  const tried = new Set();
  for (const fee of TIERS) {
    if (tried.has(fee)) continue;
    tried.add(fee);
    const out = await trySwapOnFee(router, quoter, tokenIn, tokenOut, amountIn, fee, wallet, provider);
    if (out !== null) return out;
  }
  return null;
}

// poolInfo: { dex, token0, token1, fee, tickSpacing, decimals0, decimals1, poolAddr }
// Returns: { token0Bal, token1Bal } or null
export async function genericSwap(poolInfo, amountEth, provider, wallet) {
  const sym0 = poolInfo.decimals0 === 6 ? 'USDG' : '';

  if (!wallet) {
    console.log(`\n=== genericSwap (DRY) — ${poolInfo.poolAddr.slice(0, 14)}...`);
    console.log(`  Would swap ${formatEther(amountEth)} ETH → tokens`);
    if (poolInfo.dex === 'V3') {
      console.log(`  token0=${poolInfo.token0} (${poolInfo.decimals0}d)`);
      console.log(`  token1=${poolInfo.token1} (${poolInfo.decimals1}d)`);
      console.log(`  fee=${poolInfo.fee}  tickSpacing=${poolInfo.tickSpacing}`);
    }
    return null;
  }

  console.log(`\n=== genericSwap — ${poolInfo.poolAddr.slice(0, 14)} ===`);

  if (poolInfo.dex !== 'V3') {
    console.log(`  SKIP: only V3 swaps supported in Phase 2`);
    return null;
  }

  const wethAddr = await getWethAddress(provider);
  const isWeth0 = poolInfo.token0.toLowerCase() === wethAddr.toLowerCase();
  const isWeth1 = poolInfo.token1.toLowerCase() === wethAddr.toLowerCase();

  if (!isWeth0 && !isWeth1) {
    console.log(`  SKIP: neither token is WETH — multi-hop not supported yet`);
    return null;
  }

  const weth = new Contract(wethAddr, WETH_ABI, wallet);
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);
  const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);

  // Split amount: half for non-WETH side, half kept as WETH
  const swapAmount = amountEth / 2n;
  const wethAmount = amountEth - swapAmount;

  console.log(`  Total: ${formatEther(amountEth)} ETH → ${formatEther(swapAmount)} for swap + ${formatEther(wethAmount)} WETH kept`);

  // Step 1: Wrap ETH → WETH
  await wrapEth(wallet, weth, amountEth);

  // Step 2: Approve router for WETH
  const wethToken = new Contract(wethAddr, ERC20_ABI, wallet);
  await approveToken(wethToken, V3.swapRouter02, swapAmount, wallet, 'WETH');

  // Step 3: Swap WETH → non-WETH token
  const tokenOut = isWeth0 ? poolInfo.token1 : poolInfo.token0;
  const labelOut = isWeth0 ? 'token1' : 'token0';

  console.log(`\n--- Swap WETH → ${tokenOut.slice(0, 10)}... (${labelOut}) ---`);
  const outDecimals = isWeth0 ? poolInfo.decimals1 : poolInfo.decimals0;

  const result = await swapWithFeeDiscovery(router, quoter, wethAddr, tokenOut, swapAmount, wallet, provider);
  if (result === null) {
    console.log(`  SWAP FAILED — no fee tier worked`);
    return null;
  }

  // Final balances
  const token0 = new Contract(poolInfo.token0, ERC20_ABI, provider);
  const token1 = new Contract(poolInfo.token1, ERC20_ABI, provider);
  const bal0 = await token0.balanceOf(wallet.address);
  const bal1 = await token1.balanceOf(wallet.address);
  const wethFinal = await weth.balanceOf(wallet.address);
  console.log(`\nBalances after swap:`);
  console.log(`  token0: ${formatUnits(bal0, poolInfo.decimals0)}`);
  console.log(`  token1: ${formatUnits(bal1, poolInfo.decimals1)}`);
  console.log(`  WETH:   ${formatEther(wethFinal)}`);

  return { token0Bal: bal0, token1Bal: bal1 };
}

// ===== GENERIC DEPOSIT =====
// Maps poolInfo → depositV3/depositV4 from lp_deposit.js (single source of truth)
export async function genericDeposit(poolInfo, amountEth, provider, wallet, config = null) {
  const cfg = config || { rangeSymmetricPct: 15, slippagePct: 1, deadlineSec: 300 };

  if (!wallet) {
    console.log(`\n=== genericDeposit (DRY) — ${poolInfo.poolAddr.slice(0, 14)}...`);
    console.log(`  Would create ${poolInfo.dex} LP position`);
    return null;
  }

  if (poolInfo.dex === 'V3') {
    return await depositV3(provider, wallet, cfg, {
      token0: poolInfo.token0, token1: poolInfo.token1,
      fee: poolInfo.fee, tickSpacing: poolInfo.tickSpacing,
      poolAddr: poolInfo.poolAddr, decimals0: poolInfo.decimals0,
      decimals1: poolInfo.decimals1, baseToken: poolInfo.baseToken,
      quoteToken: poolInfo.quoteToken,
    });
  }
  if (poolInfo.dex === 'V4') {
    if (poolInfo.partial) {
      console.log('  SKIP: V4 pool with incomplete data (fee/tickSpacing unknown)');
      return null;
    }
    return await depositV4(provider, wallet, cfg, {
      currency0: poolInfo.currency0, currency1: poolInfo.currency1,
      fee: poolInfo.fee, tickSpacing: poolInfo.tickSpacing,
      hooks: poolInfo.hooks, decimals0: poolInfo.decimals0,
      decimals1: poolInfo.decimals1, baseToken: poolInfo.baseToken,
      quoteToken: poolInfo.quoteToken,
    });
  }
  console.log(`  SKIP: unknown dex type ${poolInfo.dex}`);
  return null;
}

// ===== AUTO-OPEN EXECUTE (Phase 2) =====
// Orchestrates swap + deposit for a pool that passes all conditions.
// Only executes when AUTO_OPEN_DRY=0.
export async function autoOpenExecute(po, provider) {
  const b = po.baseToken;
  const q = po.quoteToken;
  const sym = `${b?.symbol || '?'}/${q?.symbol || '?'}`;

  console.log(`\n====== AUTO-OPEN EXECUTE: ${sym} ======`);

  // Enrich pool data
  const poolInfo = await enrichPoolData(po, provider);
  if (!poolInfo) {
    console.log('  FAILED: pool enrichment returned null');
    await tgScreener(`❌ <b>AUTO-OPEN FAILED</b> — ${sym}\nPool enrichment failed`).catch(() => {});
    return null;
  }

  if (poolInfo.dex === 'V4' && poolInfo.partial) {
    console.log('  SKIP: V4 pool with incomplete data');
    await tgScreener(`⏭ <b>AUTO-OPEN SKIP</b> — ${sym}\nV4 pool incomplete (fee/tickSpacing unknown)`).catch(() => {});
    return null;
  }

  // Create wallet
  let wallet = null;
  if (AUTO_OPEN_DRY === 0 && process.env.PRIVATE_KEY) {
    wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);
  } else {
    console.log('DRY-RUN mode — no wallet');
    await autoOpenDryRun(po, provider);
    return null;
  }

  // Step 1: Swap
  const amountEth = parseEther('0.01'); // 0.005 ETH per side = 0.01 total
  console.log(`\n--- Step 1: Swap ${formatEther(amountEth)} ETH → tokens ---`);
  const swapResult = await genericSwap(poolInfo, amountEth, provider, wallet);
  if (!swapResult) {
    const errMsg = 'Swap failed (no working fee tier)';
    console.log(`  ${errMsg}`);
    await tgScreener(`❌ <b>AUTO-OPEN FAILED</b> — ${sym}\n${errMsg}`).catch(() => {});
    return null;
  }

  // Step 2: Deposit
  console.log(`\n--- Step 2: Create LP position ---`);
  const config = UC('lp');
  const position = await genericDeposit(poolInfo, amountEth, provider, wallet, config);
  if (!position) {
    const errMsg = 'Deposit failed';
    console.log(`  ${errMsg}`);
    await tgScreener(`❌ <b>AUTO-OPEN FAILED</b> — ${sym}\n${errMsg}`).catch(() => {});
    return null;
  }

  // Success notification
  const msg = [
    `✅ <b>AUTO-OPEN SUCCESS</b> — ${sym}`,
    ``,
    `Token: <code>${b?.address || '?'}</code>`,
    `Pool: <code>${po.pairAddress}</code>`,
    `DEX: ${position.dex}`,
    `Token ID: <code>${position.tokenId}</code>`,
    `Tx: <code>${position.tx}</code>`,
    ``,
    `💰 Amount: ${formatEther(amountEth)} ETH`,
    `📊 Score: ${po.score}/100 | Trend: rising`,
  ].join('\n');

  console.log(`\n✅ AUTO-OPEN SUCCESS: ${sym} — tokenId=${position.tokenId} tx=${position.tx}`);
  await tgScreener(msg).catch(() => {});
  return position;
}
