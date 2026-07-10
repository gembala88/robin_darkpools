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
import { Contract, Wallet, JsonRpcProvider, Network, parseEther, formatEther, MaxUint256, id as topicId, getAddress, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, ERC20_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, QUOTER_ABI, buildV4Swap } from './abis.js';
import { CURVE, V4, TOKEN, POOLS } from './config.js';
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
  gasUnits: BigInt(process.env.GAS_UNITS || 700000),
  iters: Number(process.env.TERNARY_ITERS || 12),
  live: process.env.LIVE === '1',
  executor: process.env.EXECUTOR_ADDR || null,
  watchlist: process.env.WATCHLIST === '1',
};
const bpsDown = (x, bps) => x - (x * bps) / 10000n;
const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);

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
  const provider = await makeProvider();
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
  console.log(`wallet: ${wallet ? wallet.address : '(monitor only)'}`);
  console.log(`markets: ${markets.map(m => `${m.symbol}(${m.pools.map(p => p.name).join('/')})`).join(', ')}`);
  console.log(`gate >= ${CFG.minProfitBps} bps | size [${formatEther(CFG.minSize)}, ${formatEther(CFG.maxSize)}] ETH\n`);

  const v4Sell = (tok, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), false, tok, '0x']).then(r => r[0]).catch(() => 0n);
  const v4Buy  = (eth, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), true, eth, '0x']).then(r => r[0]).catch(() => 0n);

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
      const before = await execProvider.getBalance(executor.target);
      let rc;
      if (b.dir === 'A') {
        const minTok = bpsDown(await curve.quoteBuy(token, b.size), CFG.slippageBps);
        console.log(`  [atomic A] ${b.market.symbol} pool=${b.pool.name} size=${formatEther(b.size)}`);
        rc = await (await executor.curveToV4(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit)).wait();
      } else {
        const minTok = bpsDown(b.tok, CFG.slippageBps);
        console.log(`  [atomic B] ${b.market.symbol} pool=${b.pool.name} size=${formatEther(b.size)}`);
        rc = await (await executor.v4ToCurve(token, b.size, minTok, keyTuple(b.pool.key), minEth, minProfit)).wait();
      }
      let net = 0n;
      try { net = (await execProvider.getBalance(executor.target)) - before; } catch {}
      console.log('  tx', rc.hash, '| net', formatEther(net), 'ETH');
      // fire-and-forget so a notif hiccup can never block/crash the trade loop
      notifyAtomic({ symbol: b.market.symbol, dir: b.dir, buyVenue: b.dir === 'A' ? 'curve' : `V4 ${b.pool.name}`, sellVenue: b.dir === 'A' ? `V4 ${b.pool.name}` : 'curve', sizeEth: b.size, receipt: rc, netEth: net }).catch(() => {});
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
    console.log(`  [A] buy curve ${b.market.symbol} ${formatEther(b.size)} ETH`);
    const buyRc = await (await curve.buy(token, bpsDown(q, CFG.slippageBps), { value: b.size })).wait();
    const got = (await t.balanceOf(wallet.address)) - before;
    await notifyBuy({ symbol: b.market.symbol, venue: 'curve', ethIn: b.size, tokens: got, hash: buyRc.hash });
    const target = b.size + gasCost + (b.size * CFG.minProfitBps) / 10000n;
    try {
      const sw = buildV4Swap({ zeroForOne: false, amountIn: got, amountOutMin: target, deadline: deadline(), key: b.pool.key });
      console.log(`  [A] sell V4 ${b.pool.name} ${formatEther(got)} tok, min ${formatEther(target)} ETH`);
      const sellRc = await (await router.execute(sw.commands, sw.inputs, sw.deadline, { value: sw.value })).wait();
      console.log('  PROFIT tx', sellRc.hash);
      const s = parseSwap(sellRc);
      await notifySell({ symbol: b.market.symbol, venue: `V4 ${b.pool.name}`, tokens: got, ethOut: s ? s.ethAbs : 0n, hash: sellRc.hash });
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
    console.log(`  [B] buy V4 ${b.pool.name} ${b.market.symbol} ${formatEther(b.size)} ETH`);
    const buyRc = await (await router.execute(sw.commands, sw.inputs, sw.deadline, { value: sw.value })).wait();
    const got = (await t.balanceOf(wallet.address)) - before;
    await notifyBuy({ symbol: b.market.symbol, venue: `V4 ${b.pool.name}`, ethIn: b.size, tokens: got, hash: buyRc.hash });
    const qSell = await curve.quoteSell(token, got);
    const minEth = bpsDown(qSell, CFG.slippageBps);
    console.log(`  [B] sell curve ${formatEther(got)} tok, min ${formatEther(minEth)} ETH`);
    const sellRc = await (await curve.sell(token, got, minEth)).wait();
    console.log('  done tx', sellRc.hash);
    await notifySell({ symbol: b.market.symbol, venue: 'curve', tokens: got, ethOut: qSell, hash: sellRc.hash });
  }

  let busy = false, lastLog = 0;
  async function tick(trigger = 'poll') {
    if (busy) return;
    const all = await scanAll();
    if (!all.length) return;
    const b = all[0];
    const bps = b.size > 0n ? (b.net * 10000n) / b.size : 0n;
    const line = `${new Date().toISOString()} [${trigger}] best=${b.market.symbol} ${b.tag}@${b.pool?.name} size=${formatEther(b.size)} net=${formatEther(b.net)} (${bps} bps)`;
    if (bps >= CFG.minProfitBps) {
      console.log('>>> OPPORTUNITY', line);
      if (!CFG.live || !wallet) { console.log('    (idle: dry-run/no wallet)'); return; }
      busy = true;
      try { await execute(b); }
      catch (e) { console.log('    exec FAILED:', e.shortMessage || e.message); await notifyError(`${b.market.symbol} ${b.tag}: ${e.shortMessage || e.message}`); }
      finally { busy = false; gasCost = ((await provider.getFeeData()).gasPrice ?? gasPrice) * CFG.gasUnits; }
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
  const coder = AbiCoder.defaultAbiCoder();
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
