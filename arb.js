// arb.js — RobinFun curve <-> Uniswap V4 arb on Robinhood Chain (4663).
//
// Multi-token + multi-pool. By default watches the token in config.js; with
// WATCHLIST=1 it loads watchlist.json (produced by `node scanner.js`) and watches
// EVERY discovered token that has an active curve + a liquid V4 pool.
//
// For each market it quotes both directions, across every pool, at the OPTIMAL
// size (ternary search), and fires only if net (after curve fee, V4 fee, slippage,
// gas) >= MIN_PROFIT_BPS. Event-driven: re-quotes on any V4 Swap of a watched pool.
//
// Execution:
//   ATOMIC (EXECUTOR_ADDR set): one tx, reverts unless profitable. No inventory risk.
//   EOA fallback: 2 txs; a missed V4 sell unwinds back to the curve (~fee loss).
//
//   node arb.js                                        # dry-run, config token
//   WATCHLIST=1 node arb.js                             # dry-run, all discovered tokens
//   LIVE=1 PRIVATE_KEY=0x.. EXECUTOR_ADDR=0x.. WATCHLIST=1 node arb.js

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, JsonRpcProvider, Network, parseEther, formatEther, MaxUint256, id as topicId, getAddress, AbiCoder, keccak256, toUtf8Bytes, dataSlice } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, ERC20_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, QUOTER_ABI, buildV4Swap } from './abis.js';
import { CURVE, V4, TOKEN, POOLS, UC } from './config.js';
import { notifyStartup, notifyBuy, notifySell, notifyAtomic, notifyError, parseSwap, tg, tgEnabled } from './telegram.js';

const EXECUTOR_ABI = [
  'function curveToV4(address token,uint256 ethIn,uint256 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint128 minEthOut,uint256 minProfit)',
  'function v4ToCurve(address token,uint256 ethIn,uint128 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint256 minEthOut,uint256 minProfit)',
];

const CFG = {
  minSize: parseEther(process.env.MIN_SIZE_ETH || '0.002'),
  maxSize: parseEther(process.env.MAX_SIZE_ETH || '0.3'),
  minProfitBps: BigInt(process.env.MIN_PROFIT_BPS || 150),
  slippageBps: BigInt(process.env.SLIPPAGE_BPS || 100),
  pollMs: Number(process.env.POLL_MS || 3000),
  gasUnits: BigInt(process.env.GAS_UNITS || UC('gasUnits')),
  iters: Number(process.env.TERNARY_ITERS || 12),
  live: process.env.LIVE === '1',
  executor: process.env.EXECUTOR_ADDR || null,
  watchlist: process.env.WATCHLIST === '1',
  eoaFallback: UC('eoaFallbackEnabled'),
};

// ===== CIRCUIT BREAKER (reads from user-config.json, env can override) =====
const CB = { fails: 0, paused: false, pausedAt: 0, maxFails: Number(process.env.MAX_CONSECUTIVE_FAILS || UC('maxConsecutiveFails')), cooldownMin: Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MIN || UC('circuitBreakerCooldownMin')) };
async function checkCircuitBreaker() {
  if (!CB.paused) return true;
  if (Date.now() - CB.pausedAt > CB.cooldownMin * 60 * 1000) {
    CB.paused = false; CB.fails = 0;
    console.log('circuit breaker auto-reset after cooldown');
  }
  return !CB.paused;
}
function recordFail() {
  CB.fails++;
  if (CB.fails >= CB.maxFails) {
    CB.paused = true; CB.pausedAt = Date.now();
    console.log(`!!! CIRCUIT BREAKER ACTIVE — ${CB.fails} consecutive fails`);
    notifyError(`Circuit breaker active — ${CB.fails} consecutive tx failures. Auto-reset in ${CB.cooldownMin}min.`).catch(() => {});
  }
}
const errorThrottle = new Map();
function throttleError(tokenTag, reason) {
  const now = Date.now();
  const key = `${tokenTag}:${(reason||'').slice(0,80)}`;
  const prev = errorThrottle.get(key);
  if (prev && now - prev.start < 300000) { prev.count++; return; }
  const count = prev ? prev.count : 0;
  errorThrottle.set(key, { start: now, count: 0 });
  const suffix = count > 0 ? ` (repeated ${count}x in 5min)` : '';
  notifyError(`${tokenTag}: ${reason}${suffix}`).catch(() => {});
}

const bpsDown = (x, bps) => x - (x * bps) / 10000n;
const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);
const coder = AbiCoder.defaultAbiCoder();

function loadMarkets() {
  if (CFG.watchlist) {
    const wl = JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url)));
    return wl.map(w => ({ token: w.token, symbol: w.symbol,
      pools: w.pools.map(p => ({ name: p.feePct + '%', id: p.id, key: p.key })) }));
  }
  return [{ token: TOKEN.address, symbol: TOKEN.symbol,
    pools: POOLS.map(p => ({ name: p.name, id: p.id, key: p.key })) }];
}

async function main() {
  const provider = await makeProvider('ARB_RPC_URL');
  provider.pollingInterval = Number(process.env.EVENT_POLL_MS || 6000); // Swap-event getLogs cadence
  const wallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
  const runner = wallet || provider;

  // Dedicated EXECUTION provider (e.g. Alchemy) — reliable for trade txs, keeps the
  // flaky public RPC for cheap monitoring only. Falls back to the monitor provider.
  let execProvider = provider, execWallet = wallet;
  if (process.env.EXEC_RPC_URL && wallet) {
    const enet = new Network('robinhood', 4663);
    execProvider = new JsonRpcProvider(process.env.EXEC_RPC_URL, enet, { staticNetwork: enet });
    execWallet = new Wallet(process.env.PRIVATE_KEY, execProvider);
    console.log('exec RPC: dedicated');
  }

  const markets = loadMarkets();
  const curve = new Contract(CURVE.address, CURVE_ABI, runner);
  const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
  const permit2 = new Contract(V4.permit2, PERMIT2_ABI, execWallet || runner);
  const router = new Contract(V4.universalRouter, UNIVERSAL_ROUTER_ABI, execWallet || runner);
  const executor = CFG.executor && execWallet ? new Contract(CFG.executor, EXECUTOR_ABI, execWallet) : null;
  const erc = (addr) => new Contract(addr, ERC20_ABI, execWallet || runner);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 100000000n;
  let gasCost = gasPrice * CFG.gasUnits;

  console.log(`\nRobinFun<->UniV4 arb | ${CFG.live ? 'LIVE' : 'DRY-RUN'} | ${executor ? 'ATOMIC' : 'EOA'} | ${CFG.watchlist ? 'WATCHLIST' : 'single'}`);
  if (!CFG.executor && !CFG.eoaFallback) {
    console.error('FATAL: EOA fallback disabled (eoaFallbackEnabled=false) and no EXECUTOR_ADDR set.');
    process.exit(1);
  }
  if (!CFG.executor && CFG.eoaFallback) console.log('EOA fallback: ENABLED (2-tx mode)');
  console.log(`wallet: ${wallet ? wallet.address : '(monitor only)'}`);
  console.log(`markets: ${markets.map(m => `${m.symbol}(${m.pools.map(p => p.name).join('/')})`).join(', ')}`);
  console.log(`gate >= ${CFG.minProfitBps} bps | size [${formatEther(CFG.minSize)}, ${formatEther(CFG.maxSize)}] ETH\n`);

  // V4 Quoter uses revert-based unlock/callback pattern which doesn't work via
  // eth_call on Robinhood Chain. Instead, compute quotes from pool state directly
  // via the StateView contract (view functions, always safe to call).
  const STATE_VIEW = V4.stateView;
  const SLOT0_SIG = dataSlice(keccak256(toUtf8Bytes('getSlot0(bytes32)')), 0, 4);
  const LIQ_SIG = dataSlice(keccak256(toUtf8Bytes('getLiquidity(bytes32)')), 0, 4);
  const Q192 = (1n << 96n) * (1n << 96n);
  async function v4Quote(key, zeroForOne, exactAmount) {
    const pid = keccak256(coder.encode(['(address,address,uint24,int24,address)'], [keyTuple(key)]));
    try {
      const [slot0, liq] = await Promise.all([
        provider.call({ to: STATE_VIEW, data: SLOT0_SIG + coder.encode(['bytes32'], [pid]).slice(2) }),
        provider.call({ to: STATE_VIEW, data: LIQ_SIG + coder.encode(['bytes32'], [pid]).slice(2) }),
      ]);
      const [sqrtP, , , lpFee] = coder.decode(['uint160', 'int24', 'uint24', 'uint24'], slot0);
      const [liquidity] = coder.decode(['uint128'], liq);
      if (liquidity === 0n) return 0n;
      const feeBps = BigInt(lpFee) / 100n;
      const amountAfterFee = BigInt(exactAmount) * (10000n - feeBps) / 10000n;
      if (zeroForOne) {
        // sell token0 (ETH) -> token1 (RH6900): amount1 = amount0 * factor * sqrtP^2 / 2^192
        return amountAfterFee * BigInt(sqrtP) * BigInt(sqrtP) / Q192;
      } else {
        // sell token1 (RH6900) -> token0 (ETH): amount0 = amount1 * factor * 2^192 / sqrtP^2
        return amountAfterFee * Q192 / (BigInt(sqrtP) * BigInt(sqrtP));
      }
    } catch { return 0n; }
  }
  const v4Sell = (tok, key) => v4Quote(key, false, tok);
  const v4Buy  = (eth, key) => v4Quote(key, true, eth);

  async function netA(m, ethIn) { // buy curve -> sell best V4 pool
    const tok = await curve.quoteBuy(m.token, ethIn).catch(() => 0n);
    if (!tok) return { net: -ethIn, tok: 0n, back: 0n, pool: null };
    const backs = await Promise.all(m.pools.map(p => v4Sell(tok, p.key)));
    let bi = 0; for (let i = 1; i < backs.length; i++) if (backs[i] > backs[bi]) bi = i;
    return { net: backs[bi] - ethIn - gasCost, tok, back: backs[bi], pool: m.pools[bi] };
  }
  async function netB(m, ethIn) { // buy best V4 pool -> sell curve
    const toks = await Promise.all(m.pools.map(p => v4Buy(ethIn, p.key)));
    let bi = 0; for (let i = 1; i < toks.length; i++) if (toks[i] > toks[bi]) bi = i;
    const tok = toks[bi];
    if (!tok) return { net: -ethIn, tok: 0n, back: 0n, pool: null };
    const back = await curve.quoteSell(m.token, tok).catch(() => 0n);
    return { net: back - ethIn - gasCost, tok, back, pool: m.pools[bi] };
  }
  // geometric grid of probe sizes — deterministic, RPC-friendly (vs ternary storms)
  const GRID = Number(process.env.GRID_POINTS || 6);
  const gridSizes = (() => {
    const lo = Number(formatEther(CFG.minSize)), hi = Number(formatEther(CFG.maxSize));
    const arr = [];
    for (let i = 0; i < GRID; i++) arr.push(parseEther((lo * Math.pow(hi / lo, GRID === 1 ? 0 : i / (GRID - 1))).toFixed(9)));
    return arr;
  })();
  async function bestDir(m, fn) {
    const rs = await Promise.all(gridSizes.map(s => fn(m, s).then(r => ({ size: s, ...r })).catch(() => null)));
    return rs.filter(Boolean).reduce((a, b) => (!a || b.net > a.net ? b : a), null);
  }
  async function scanMarket(m) {
    const [A, B] = await Promise.all([bestDir(m, netA), bestDir(m, netB)]);
    const a = { dir: 'A', tag: 'curve->V4', market: m, ...A };
    const b = { dir: 'B', tag: 'V4->curve', market: m, ...B };
    return (A && B) ? (a.net >= b.net ? a : b) : null;
  }
  async function scanAll() {
    const results = await Promise.all(markets.map(m => scanMarket(m).catch(() => null)));
    return results.filter(Boolean).sort((x, y) => (y.net > x.net ? 1 : -1));
  }

  // EOA-mode lazy approvals per token
  const eoaApproved = new Set();
  async function ensureEOA(tokenAddr) {
    if (executor || eoaApproved.has(tokenAddr)) return;
    const t = erc(tokenAddr);
    for (const [sp] of [[V4.permit2], [CURVE.address]]) {
      if ((await t.allowance(wallet.address, sp)) < MaxUint256 / 2n) await (await t.approve(sp, MaxUint256)).wait();
    }
    const [pa] = await permit2.allowance(wallet.address, tokenAddr, V4.universalRouter);
    if (pa < (1n << 159n)) await (await permit2.approve(tokenAddr, V4.universalRouter, (1n << 160n) - 1n, 2n ** 48n - 1n)).wait();
    eoaApproved.add(tokenAddr);
  }

  async function execute(b) {
    const token = b.market.token;
    const minProfit = (b.size * CFG.minProfitBps) / 10000n;
    const minEth = b.size + minProfit;
    if (executor) {
      // Fire IMMEDIATELY — reuse the size the scan already quoted (b.tok). No
      // pre-fire getBalance/quoteBuy: a hung RPC call there used to leave busy=true
      // and stall the bot past the window (missed a live opportunity). Net is
      // computed from the receipt in notifyAtomic, so no post-fire balance read.
      const minTok = bpsDown(b.tok, CFG.slippageBps);
      console.log(`  [atomic ${b.dir}] ${b.market.symbol} (${b.market.token.slice(0,8)}…) pool=${b.pool.name} size=${formatEther(b.size)}`);
      const call = b.dir === 'A'
        ? executor.curveToV4(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit)
        : executor.v4ToCurve(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit);
      const rc = await (await call).wait();
      console.log('  tx', rc.hash);
      // fire-and-forget so a notif hiccup can never block/crash the trade loop
      notifyAtomic({ symbol: b.market.symbol, token: b.market.token, dir: b.dir, buyVenue: b.dir === 'A' ? 'curve' : `V4 ${b.pool.name}`, sellVenue: b.dir === 'A' ? `V4 ${b.pool.name}` : 'curve', sizeEth: b.size, receipt: rc, netEth: 0n }).catch(() => {});
      return;
    }
    await ensureEOA(token);
    if (b.dir === 'A') return execEOA_A(b);
    return execEOA_B(b);
  }

  async function execEOA_A(b) {
    const token = b.market.token, t = erc(token);
    const q = await curve.quoteBuy(token, b.size);
    const before = await t.balanceOf(wallet.address);
    console.log(`  [A] buy curve ${b.market.symbol} (${b.market.token.slice(0,8)}…) ${formatEther(b.size)} ETH`);
    const buyRc = await (await curve.buy(token, bpsDown(q, CFG.slippageBps), { value: b.size })).wait();
    const got = (await t.balanceOf(wallet.address)) - before;
    await notifyBuy({ symbol: b.market.symbol, token: b.market.token, venue: 'curve', ethIn: b.size, tokens: got, hash: buyRc.hash });
    const target = b.size + gasCost + (b.size * CFG.minProfitBps) / 10000n;
    try {
      const sw = buildV4Swap({ zeroForOne: false, amountIn: got, amountOutMin: target, deadline: deadline(), key: b.pool.key });
      console.log(`  [A] sell V4 ${b.pool.name} ${formatEther(got)} tok, min ${formatEther(target)} ETH`);
      const sellRc = await (await router.execute(sw.commands, sw.inputs, sw.deadline, { value: sw.value })).wait();
      console.log('  PROFIT tx', sellRc.hash);
      const s = parseSwap(sellRc);
      await notifySell({ symbol: b.market.symbol, token: b.market.token, venue: `V4 ${b.pool.name}`, tokens: got, ethOut: s ? s.ethAbs : 0n, hash: sellRc.hash });
    } catch (e) {
      console.log('  missed window -> unwind on curve:', e.shortMessage || e.message);
      const minEth = bpsDown(await curve.quoteSell(token, got), CFG.slippageBps);
      const unwRc = await (await curve.sell(token, got, minEth)).wait();
      console.log('  unwound tx', unwRc.hash);
      await tg(`↩️ <b>UNWIND</b> ${b.market.symbol} on curve (window closed) — tx ${unwRc.hash.slice(0, 10)}…`);
    }
  }
  async function execEOA_B(b) {
    const token = b.market.token, t = erc(token);
    const before = await t.balanceOf(wallet.address);
    const sw = buildV4Swap({ zeroForOne: true, amountIn: b.size, amountOutMin: bpsDown(b.tok, CFG.slippageBps), deadline: deadline(), key: b.pool.key });
    console.log(`  [B] buy V4 ${b.pool.name} ${b.market.symbol} (${b.market.token.slice(0,8)}…) ${formatEther(b.size)} ETH`);
    const buyRc = await (await router.execute(sw.commands, sw.inputs, sw.deadline, { value: sw.value })).wait();
    const got = (await t.balanceOf(wallet.address)) - before;
    await notifyBuy({ symbol: b.market.symbol, token: b.market.token, venue: `V4 ${b.pool.name}`, ethIn: b.size, tokens: got, hash: buyRc.hash });
    const qSell = await curve.quoteSell(token, got);
    const minEth = bpsDown(qSell, CFG.slippageBps);
    console.log(`  [B] sell curve ${formatEther(got)} tok, min ${formatEther(minEth)} ETH`);
    const sellRc = await (await curve.sell(token, got, minEth)).wait();
    console.log('  done tx', sellRc.hash);
    await notifySell({ symbol: b.market.symbol, token: b.market.token, venue: 'curve', tokens: got, ethOut: qSell, hash: sellRc.hash });
  }

  let busy = false, lastLog = 0, lastGasRefresh = 0;
  async function tick(trigger = 'poll') {
    if (busy) return;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout ' + ms + 'ms')), ms))]);
    // Refresh gas price every 15s so profit calcuses current on-chain cost
    if (Date.now() - lastGasRefresh > 15000) {
      const fd = await withTimeout(provider.getFeeData(), 10000).catch(() => null);
      if (fd) { gasCost = (fd.gasPrice ?? fd.maxFeePerGas ?? 100000000n) * CFG.gasUnits; lastGasRefresh = Date.now(); }
    }
    let all;
    try {
      all = await withTimeout(scanAll(), 15000);
    } catch (e) {
      console.log('    scan timeout/error (ignored, retry next tick):', e.shortMessage || e.message);
      return;
    }
    if (!all.length) return;
    const b = all[0];
    const bps = b.size > 0n ? (b.net * 10000n) / b.size : 0n;
    const line = `${new Date().toISOString()} [${trigger}] best=${b.market.symbol} (${b.market.token.slice(0,8)}…) ${b.tag}@${b.pool?.name} size=${formatEther(b.size)} net=${formatEther(b.net)} (${bps} bps)`;
    if (bps >= CFG.minProfitBps) {
      console.log('>>> OPPORTUNITY', line);
      if (!CFG.live || !wallet) { console.log('    (idle: dry-run/no wallet)'); return; }
      // Circuit breaker: pause after N consecutive failures
      if (!await checkCircuitBreaker()) { console.log('    (paused — circuit breaker active)'); return; }
      // Balance check: skip if executor/wallet can't cover size + gas
      const bcAddr = CFG.executor || wallet.address;
      const bcBal = await provider.getBalance(bcAddr).catch(() => 0n);
      const bcGas = (gasPrice || 100000000n) * CFG.gasUnits;
      const bcNeed = b.size + bcGas;
      if (bcBal < bcNeed) {
        console.log(`    (balance skip: ${formatEther(bcBal)} < ${formatEther(bcNeed)} = size ${formatEther(b.size)} + gas ${formatEther(bcGas)})`);
        return;
      }
      busy = true;
      try {
        // hard 120s cap: a hung RPC inside execute() must never leave busy=true
        // and stall the bot past the next window (that missed a live opportunity).
        await Promise.race([execute(b), new Promise((_, rej) => setTimeout(() => rej(new Error('execute timeout 120s')), 120000))]);
        CB.fails = 0; // reset HANYA setelah eksekusi terkonfirmasi sukses (tidak throw)
      } catch (e) {
        console.log('    exec FAILED:', e.shortMessage || e.message);
        throttleError(`${b.market.symbol} (${b.market.token.slice(0,8)}…) ${b.tag}`, e.shortMessage || e.message);
        recordFail();
      } finally {
        busy = false;
        // non-blocking gas refresh — getFeeData must not hang the busy reset
        provider.getFeeData().then((fd) => { gasCost = (fd.gasPrice ?? gasPrice) * CFG.gasUnits; }).catch(() => {});
      }
    } else if (Date.now() - lastLog > 15000 || trigger === 'swap') {
      lastLog = Date.now(); console.log('idle    ', line);
    }
  }

  // resilience: never let a background poller rejection kill the bot
  provider.on('error', (e) => console.log('provider error (ignored):', e?.shortMessage || e?.message || e));
  process.on('unhandledRejection', (e) => console.log('unhandledRejection (ignored):', e?.shortMessage || e?.message || e));
  process.on('uncaughtException', (e) => console.log('uncaughtException (ignored):', e?.shortMessage || e?.message || e));

  // event-driven: ONE subscription for all watched pools (topic1 = OR of poolIds)
  const swapTopic = topicId('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
  const watchedIds = [...new Set(markets.flatMap(m => m.pools.map(p => p.id)))];
  try { provider.on({ address: V4.poolManager, topics: [swapTopic, watchedIds] }, () => tick('swap')); }
  catch (e) { console.log('event sub failed, poll-only:', e?.message); }

  // persist current markets back to watchlist.json (survives restart)
  function persistWatchlist() {
    if (!CFG.watchlist) return;
    try {
      const out = markets.map(m => ({ token: m.token, symbol: m.symbol,
        pools: m.pools.map(p => ({ id: p.id, feePct: Number(p.key.fee) / 1e6 * 100, key: p.key })) }));
      fs.writeFileSync(new URL('./watchlist.json', import.meta.url), JSON.stringify(out, null, 2));
    } catch {}
  }

  // REAL-TIME: watch for NEW native-ETH V4 pools of active-curve tokens and add them live
  const initTopic = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
  const knownPoolIds = new Set(watchedIds.map(x => x.toLowerCase()));
  async function onNewPool(log) {
    try {
      const poolId = log.topics[1];
      if (knownPoolIds.has(poolId.toLowerCase())) return;
      const c0 = getAddress('0x' + log.topics[2].slice(26));
      if (BigInt(c0) !== 0n) return;                         // require native ETH currency0
      const c1 = getAddress('0x' + log.topics[3].slice(26));
      const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], log.data);
      const cs = await curve.curves(c1).catch(() => null);   // token must be on an active, not-graduated curve
      if (!cs || !(cs.raiseTarget > 0n && cs.realEth < cs.raiseTarget)) return;
      const sym = await new Contract(c1, ['function symbol() view returns (string)'], provider).symbol().catch(() => '?');
      const key = { currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
      const pool = { name: (Number(fee) / 1e6 * 100) + '%', id: poolId, key };
      let m = markets.find(x => x.token.toLowerCase() === c1.toLowerCase());
      if (m) m.pools.push(pool); else { m = { token: c1, symbol: sym, pools: [pool] }; markets.push(m); }
      knownPoolIds.add(poolId.toLowerCase());
      provider.on({ address: V4.poolManager, topics: [swapTopic, poolId] }, () => tick('swap'));
      persistWatchlist();
      console.log(`NEW POOL: ${sym} @ ${pool.name} (${c1})`);
      await tg(`🆕 <b>New token detected</b>: ${sym} @ ${pool.name} pool — now watching`);
      tick('newpool');
    } catch { /* ignore malformed logs */ }
  }
  try { provider.on({ address: V4.poolManager, topics: [initTopic] }, (log) => onNewPool(log)); }
  catch (e) { console.log('init sub failed:', e?.message); }

  const mode = `${CFG.live ? 'LIVE' : 'DRY-RUN'}/${executor ? 'ATOMIC' : 'EOA'}`;
  console.log('telegram:', tgEnabled ? 'ON' : 'off');
  await notifyStartup(mode, markets);
  await tick('boot');
  setInterval(() => tick('poll'), CFG.pollMs);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
