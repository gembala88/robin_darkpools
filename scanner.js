// scanner.js — auto-discover every RH-style token that is BOTH live on a RobinFun
// curve AND has a liquid Uniswap V4 pool. Uses Multicall3 to stay fast. Writes
// watchlist.json (consumed by arb.js when WATCHLIST=1).
//
//   node scanner.js
//
// Method (no API, pure on-chain):
//  1. read all PoolManager `Initialize` events -> every V4 pool + PoolKey
//  2. keep pools with currency0 == native ETH; token = currency1
//  3. Multicall curves(token): keep tokens with an active, not-graduated curve
//  4. Multicall getLiquidity(poolId): keep pools with liquidity > 0

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Interface, AbiCoder, id as topicId, getAddress, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE, V4 } from './config.js';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const coder = AbiCoder.defaultAbiCoder();
const CURVE_I = new Interface(['function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)']);
const ERC20_I = new Interface(['function symbol() view returns (string)']);
const SV_I = new Interface(['function getLiquidity(bytes32) view returns (uint128)']);
const INIT_TOPIC = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

async function getLogsChunked(provider, filter, from, to, step = 1_000_000) {
  const out = [];
  for (let s = from; s <= to; s += step) {
    const e = Math.min(s + step - 1, to);
    try { out.push(...await provider.getLogs({ ...filter, fromBlock: s, toBlock: e })); }
    catch (err) {
      if (e > s) { const m = (s + e) >> 1;
        out.push(...await getLogsChunked(provider, filter, s, m, m - s + 1));
        out.push(...await getLogsChunked(provider, filter, m + 1, e, e - m));
      } else throw err;
    }
  }
  return out;
}

async function main() {
  const provider = await makeProvider();
  const mc = new Contract(MULTICALL3,
    ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])'],
    provider);
  const multicall = async (calls, size = 400) => {
    const res = [];
    for (let i = 0; i < calls.length; i += size) {
      const chunk = calls.slice(i, i + size).map(c => ({ target: c.target, allowFailure: true, callData: c.callData }));
      res.push(...await mc.aggregate3(chunk));
    }
    return res;
  };

  const head = await provider.getBlockNumber();
  console.log('head', head, '| scanning V4 Initialize events...');
  const raw = await getLogsChunked(provider, { address: V4.poolManager, topics: [INIT_TOPIC] }, 0, head);
  console.log('V4 pools initialized:', raw.length);

  // decode + keep native-ETH pools
  const pools = [];
  for (const lg of raw) {
    const c0 = getAddress('0x' + lg.topics[2].slice(26));
    if (BigInt(c0) !== 0n) continue;
    const c1 = getAddress('0x' + lg.topics[3].slice(26));
    const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], lg.data);
    pools.push({ id: lg.topics[1], currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks });
  }
  const tokens = [...new Set(pools.map(p => p.currency1.toLowerCase()))];
  console.log(`native-ETH pools: ${pools.length} across ${tokens.length} tokens`);

  // 1) which tokens have an active, not-graduated curve?
  console.log('multicall curves()...');
  const curveRes = await multicall(tokens.map(t => ({ target: CURVE.address, callData: CURVE_I.encodeFunctionData('curves', [getAddress(t)]) })));
  const active = new Map(); // tokenLc -> {realEth, raiseTarget}
  tokens.forEach((t, i) => {
    const r = curveRes[i];
    if (!r.success || r.returnData === '0x') return;
    try {
      const d = CURVE_I.decodeFunctionResult('curves', r.returnData);
      if (d.raiseTarget > 0n && d.realEth < d.raiseTarget) active.set(t, { realEth: d.realEth, raiseTarget: d.raiseTarget });
    } catch {}
  });
  console.log('tokens with active curve:', active.size);

  // 2) which of their pools have liquidity?
  const candPools = pools.filter(p => active.has(p.currency1.toLowerCase()));
  console.log('multicall getLiquidity()...');
  const liqRes = await multicall(candPools.map(p => ({ target: V4.stateView, callData: SV_I.encodeFunctionData('getLiquidity', [p.id]) })));
  candPools.forEach((p, i) => {
    const r = liqRes[i];
    p.liquidity = 0n;
    if (r.success && r.returnData !== '0x') { try { p.liquidity = SV_I.decodeFunctionResult('getLiquidity', r.returnData)[0]; } catch {} }
  });
  const livePools = candPools.filter(p => p.liquidity > 0n);

  // 3) symbols
  const liveTokens = [...new Set(livePools.map(p => p.currency1.toLowerCase()))];
  const symRes = await multicall(liveTokens.map(t => ({ target: getAddress(t), callData: ERC20_I.encodeFunctionData('symbol') })));
  const symbols = new Map();
  liveTokens.forEach((t, i) => { let s = '?'; try { if (symRes[i].success) s = ERC20_I.decodeFunctionResult('symbol', symRes[i].returnData)[0]; } catch {} symbols.set(t, s); });

  // build watchlist
  const byToken = new Map();
  for (const p of livePools) {
    const t = p.currency1.toLowerCase();
    if (!byToken.has(t)) byToken.set(t, []);
    byToken.get(t).push(p);
  }
  const watchlist = [];
  for (const [t, tPools] of byToken) {
    const a = active.get(t);
    watchlist.push({
      token: getAddress(t), symbol: symbols.get(t) || '?',
      graduationPct: Number(a.realEth * 10000n / a.raiseTarget) / 100,
      pools: tPools.sort((x, y) => (y.liquidity > x.liquidity ? 1 : -1)).map(p => ({
        id: p.id, fee: p.fee, feePct: p.fee / 1e6 * 100, tickSpacing: p.tickSpacing, hooks: p.hooks,
        liquidity: p.liquidity.toString(),
        key: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks },
      })),
    });
  }
  watchlist.sort((a, b) => b.pools.length - a.pools.length || b.graduationPct - a.graduationPct);
  fs.writeFileSync('watchlist.json', JSON.stringify(watchlist, null, 2));

  console.log(`\narbitrable tokens (active curve + liquid V4 pool): ${watchlist.length}`);
  for (const w of watchlist) console.log(`  ${w.symbol.padEnd(12)} ${w.token}  grad ${w.graduationPct}%  pools ${w.pools.map(p => p.feePct + '%').join(',')}`);
  console.log('\nwrote watchlist.json');
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
