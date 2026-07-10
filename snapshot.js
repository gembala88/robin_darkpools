// snapshot.js — live arb econ across all watchlist tokens (both directions).
import 'dotenv/config';
import fs from 'node:fs';
import { Contract, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE_ABI, QUOTER_ABI } from './abis.js';
import { CURVE, V4 } from './config.js';

const wl = JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url)));
const p = await makeProvider();
const curve = new Contract(CURVE.address, CURVE_ABI, p);
const quoter = new Contract(V4.quoter, QUOTER_ABI, p);
const kt = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
const v4Sell = (k, t) => quoter.quoteExactInputSingle.staticCall([kt(k), false, t, '0x']).then(r => r[0]).catch(() => 0n);
const v4Buy = (k, e) => quoter.quoteExactInputSingle.staticCall([kt(k), true, e, '0x']).then(r => r[0]).catch(() => 0n);

const size = parseEther(process.argv[2] || '0.002');
console.log(`size ${formatEther(size)} ETH | dirA = buy curve→sell V4 | dirB = buy V4→sell curve\n`);
console.log('token        pool    dirA        dirB        grad');
for (const w of wl) {
  for (const pool of w.pools) {
    const tokA = await curve.quoteBuy(w.token, size).catch(() => 0n);
    const backA = tokA ? await v4Sell(pool.key, tokA) : 0n;
    const roiA = Number((backA - size) * 10000n / size) / 100;
    const tokB = await v4Buy(pool.key, size);
    const backB = tokB ? await curve.quoteSell(w.token, tokB).catch(() => 0n) : 0n;
    const roiB = Number((backB - size) * 10000n / size) / 100;
    const win = (backA > size || backB > size) ? '  <== WINDOW' : '';
    console.log(`${w.symbol.padEnd(12)} ${(pool.feePct + '%').padEnd(6)} ${(roiA + '%').padStart(9)}  ${(roiB + '%').padStart(9)}  ${w.graduationPct}%${win}`);
  }
}
process.exit(0);
