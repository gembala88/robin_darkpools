// forcetest.js — validate the ATOMIC execution path for EVERY detected token/pool
// by force-executing curveToV4 at a tiny size, ACCEPTING losses. Proves each pool's
// PoolKey + swap encoding works end-to-end. Withdraws remainder back to owner.
//
//   TEST_SIZE=0.0002 FUND_ETH=0.0012 WATCHLIST=1 node forcetest.js

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, QUOTER_ABI } from './abis.js';
import { CURVE, V4, TOKEN, POOLS } from './config.js';

const SIZE = parseEther(process.env.TEST_SIZE || '0.0002');
const FUND = parseEther(process.env.FUND_ETH || '0.0012');
const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const bpsDown = (x, bps) => x - (x * bps) / 10000n;

const EXECUTOR_ABI = [
  'function forceCurveToV4(address token,uint256 ethIn,uint256 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint128 minEthOut)',
  'function withdraw(uint256 amount)',
  'function owner() view returns (address)',
];

function markets() {
  if (process.env.WATCHLIST === '1' && fs.existsSync(new URL('./watchlist.json', import.meta.url))) {
    return JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url)))
      .map(w => ({ token: w.token, symbol: w.symbol, pools: w.pools.map(p => ({ name: p.feePct + '%', key: p.key })) }));
  }
  return [{ token: TOKEN.address, symbol: TOKEN.symbol, pools: POOLS.map(p => ({ name: p.name, key: p.key })) }];
}

async function main() {
  if (!process.env.PRIVATE_KEY || !process.env.EXECUTOR_ADDR) throw new Error('set PRIVATE_KEY and EXECUTOR_ADDR');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const exec = new Contract(process.env.EXECUTOR_ADDR, EXECUTOR_ABI, wallet);
  const curve = new Contract(CURVE.address, CURVE_ABI, provider);
  const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
  const v4Sell = (tok, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), false, tok, '0x']).then(r => r[0]).catch(() => 0n);

  if ((await exec.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error('not owner');
  const w0 = await provider.getBalance(wallet.address);
  console.log(`executor ${exec.target} | wallet ${formatEther(w0)} ETH | size ${formatEther(SIZE)} (loss-accepting test)\n`);

  // ensure contract has working capital for the whole run
  let cbal = await provider.getBalance(exec.target);
  if (cbal < FUND) {
    console.log(`funding contract ${formatEther(FUND - cbal)} ETH...`);
    await (await wallet.sendTransaction({ to: exec.target, value: FUND - cbal })).wait();
  }

  const results = [];
  for (const m of markets()) {
    for (const p of m.pools) {
      const label = `${m.symbol}@${p.name}`;
      try {
        const tok = await curve.quoteBuy(m.token, SIZE).catch(() => 0n);
        const back = tok ? await v4Sell(tok, p.key) : 0n;
        const expEdge = back - SIZE;
        const before = await provider.getBalance(exec.target);
        const minTok = tok ? bpsDown(tok, 500n) : 0n; // 5% curve slippage floor
        process.stdout.write(`${label.padEnd(16)} exp ${formatEther(expEdge)} ETH ... `);
        const tx = await exec.forceCurveToV4(m.token, SIZE, minTok, keyTuple(p.key), 1n); // minEthOut=1 wei (accept loss)
        const rc = await tx.wait();
        const after = await provider.getBalance(exec.target);
        const realized = after - before; // = ethOut - SIZE
        console.log(`OK ✅ realized ${formatEther(realized)} ETH | gas ${rc.gasUsed} | ${rc.hash}`);
        results.push({ label, ok: true, realized });
      } catch (e) {
        console.log(`FAIL ❌ ${e.shortMessage || e.message}`);
        results.push({ label, ok: false, err: e.shortMessage || e.message });
      }
    }
  }

  // withdraw everything back
  const cAfter = await provider.getBalance(exec.target);
  if (cAfter > 0n) { console.log(`\nwithdraw ${formatEther(cAfter)} ETH back...`); await (await exec.withdraw(cAfter)).wait(); }

  console.log('\n===== SUMMARY =====');
  for (const r of results) console.log(`  ${r.label.padEnd(16)} ${r.ok ? 'PASS  realized ' + formatEther(r.realized) + ' ETH' : 'FAIL  ' + r.err}`);
  const passed = results.filter(r => r.ok).length;
  const w1 = await provider.getBalance(wallet.address);
  console.log(`\natomic path: ${passed}/${results.length} pools executed cleanly`);
  console.log(`wallet ${formatEther(w0)} -> ${formatEther(w1)} ETH | total cost (losses+gas) ${formatEther(w1 - w0)} ETH`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
