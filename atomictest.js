// atomictest.js — live test of the ATOMIC path via deployed ArbExecutor.
// Funds the contract, runs curveToV4 (buy+sell in ONE tx, reverts unless
// profitable), then withdraws everything back to the owner wallet.
//
//   TEST_SIZE=0.0008 FUND_ETH=0.001 node atomictest.js

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, QUOTER_ABI } from './abis.js';
import { CURVE, V4, TOKEN, POOLS } from './config.js';

const SIZE = parseEther(process.env.TEST_SIZE || '0.0008');
const FUND = parseEther(process.env.FUND_ETH || '0.001');
const SLIP = BigInt(process.env.SLIPPAGE_BPS || 100);
const keyTuple = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const bpsDown = (x, bps) => x - (x * bps) / 10000n;

const EXECUTOR_ABI = [
  'function curveToV4(address token,uint256 ethIn,uint256 minTokensOut,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint128 minEthOut,uint256 minProfit)',
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
  if (!process.env.PRIVATE_KEY) throw new Error('set PRIVATE_KEY');
  if (!process.env.EXECUTOR_ADDR) throw new Error('set EXECUTOR_ADDR');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const exec = new Contract(process.env.EXECUTOR_ADDR, EXECUTOR_ABI, wallet);
  const curve = new Contract(CURVE.address, CURVE_ABI, provider);
  const quoter = new Contract(V4.quoter, QUOTER_ABI, provider);
  const v4Sell = (tok, key) => quoter.quoteExactInputSingle.staticCall([keyTuple(key), false, tok, '0x']).then(r => r[0]).catch(() => 0n);

  const owner = await exec.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wallet is not contract owner');
  const w0 = await provider.getBalance(wallet.address);
  let cbal = await provider.getBalance(exec.target);
  console.log(`executor ${exec.target} | owner OK`);
  console.log(`wallet ${formatEther(w0)} ETH | contract ${formatEther(cbal)} ETH | size ${formatEther(SIZE)}`);

  // fund the contract if it can't cover the trade
  if (cbal < SIZE) {
    console.log(`funding contract ${formatEther(FUND)} ETH...`);
    await (await wallet.sendTransaction({ to: exec.target, value: FUND })).wait();
    cbal = await provider.getBalance(exec.target);
    console.log('  contract balance now', formatEther(cbal), 'ETH');
  }

  // poll for a profitable window, fire atomic on the first one
  const MAX_WAIT_S = Number(process.env.MAX_WAIT_S || 90);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  let filled = false;
  while ((Date.now() - t0) / 1000 < MAX_WAIT_S && !filled) {
    let best = null;
    for (const m of markets()) {
      const tok = await curve.quoteBuy(m.token, SIZE).catch(() => 0n);
      if (!tok) continue;
      for (const p of m.pools) {
        const back = await v4Sell(tok, p.key);
        if (!best || back - SIZE > best.back - SIZE) best = { m, p, tok, back };
      }
    }
    const edge = best ? best.back - SIZE : 0n;
    process.stdout.write(`\r  ${new Date().toISOString()} best ${best?.m.symbol}@${best?.p.name} edge ${formatEther(edge)} ETH   `);
    if (best && edge > 0n) {
      const minTok = bpsDown(await curve.quoteBuy(best.m.token, SIZE), SLIP);
      const minEth = SIZE + edge / 2n;   // accept down to half the quoted edge
      const minProfit = minEth - SIZE;   // contract require: net gain >= this
      console.log(`\nWINDOW OPEN -> ATOMIC curveToV4 ${best.m.symbol}@${best.p.name} size ${formatEther(SIZE)} minEthOut ${formatEther(minEth)}`);
      try {
        const tx = await exec.curveToV4(best.m.token, SIZE, minTok, keyTuple(best.p.key), minEth, minProfit);
        const rc = await tx.wait();
        console.log('  atomic tx', rc.hash, '| gasUsed', rc.gasUsed.toString());
        filled = true;
      } catch (e) {
        console.log('  reverted (window closed mid-send):', e.shortMessage || e.message);
      }
    } else {
      await sleep(3000);
    }
  }
  if (!filled) console.log('\nno profitable window within wait — no trade.');

  // withdraw everything back to owner, then confirm balances by block
  let cAfter = await provider.getBalance(exec.target);
  if (cAfter > 0n) {
    console.log(`withdraw ${formatEther(cAfter)} ETH back to wallet...`);
    const rc = await (await exec.withdraw(cAfter)).wait();
    await provider.getBalance(wallet.address, rc.blockNumber); // read at the mined block
  }
  await sleep(1500);
  const w1 = await provider.getBalance(wallet.address);
  console.log(`\nRESULT: wallet ${formatEther(w0)} -> ${formatEther(w1)} ETH | delta ${formatEther(w1 - w0)} ETH (incl. all gas)`);
  console.log('contract balance:', formatEther(await provider.getBalance(exec.target)), 'ETH');
  console.log('atomic fill:', filled ? 'YES ✅' : 'no window');
  process.exit(0);
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
