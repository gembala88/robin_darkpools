import { makeProvider } from './provider.js';
import { Contract, formatEther, parseEther, formatUnits } from 'ethers';
import { V3, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG } from './config.js';
import { V3_QUOTERV2_ABI, V4_POOLMANAGER_ABI } from './abis.js';

const WETH = LP_V3_CASHCAT_WETH.token1;
const USDG = LP_V4_CASHCAT_USDG.key.currency1;
const USDG_DECIMALS = 6;
const provider = await makeProvider('ARB_RPC_URL');

console.log('=== 1. V3 USDG/WETH Pool Fees ===');
const v3PoolCandidates = [
  '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca',
  '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a',
  '0xa9188730Fe85Be88ad499D7d52B099e800fB0334',
];
for (const addr of v3PoolCandidates) {
  try {
    const fee = await provider.call({ to: addr, data: '0xddca3f43' });
    const token0raw = await provider.call({ to: addr, data: '0x0dfe1681' });
    const token1raw = await provider.call({ to: addr, data: '0xd21220a7' });
    const t0 = '0x' + token0raw.slice(26);
    const t1 = '0x' + token1raw.slice(26);
    const feeVal = Number(BigInt(fee));
    const t0sym = t0.toLowerCase() === WETH.toLowerCase() ? 'WETH' : t0.toLowerCase() === USDG.toLowerCase() ? 'USDG' : t0.slice(0,10);
    const t1sym = t1.toLowerCase() === WETH.toLowerCase() ? 'WETH' : t1.toLowerCase() === USDG.toLowerCase() ? 'USDG' : t1.slice(0,10);
    console.log(`  ${addr.slice(0,14)}: fee=${feeVal/10000}% (${feeVal}) tokens=${t0sym}/${t1sym}`);
  } catch (e) { console.log(`  ${addr.slice(0,14)}: ${e.shortMessage?.slice(0,60)}`); }
}

console.log('\n=== 2. Quote WETH→USDG via V3 Quoter ===');
const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);

const testAmount = parseEther('0.005');
const bestQuote = { pool: '', fee: 0, amountOut: 0n };
for (const poolAddr of v3PoolCandidates) {
  const feeRaw = await provider.call({ to: poolAddr, data: '0xddca3f43' });
  const fee = Number(BigInt(feeRaw));
  try {
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall([
      WETH, USDG, testAmount, fee, 0
    ]);
    const usdgHuman = formatUnits(amountOut, USDG_DECIMALS);
    console.log(`  Pool ${poolAddr.slice(0,14)} (fee=${fee/10000}%): 0.005 WETH → ${usdgHuman} USDG`);
    if (amountOut > bestQuote.amountOut) {
      bestQuote.pool = poolAddr;
      bestQuote.fee = fee;
      bestQuote.amountOut = amountOut;
    }
  } catch (e) {
    console.log(`  Pool ${poolAddr.slice(0,14)} (fee=${fee/10000}%): QUOTE FAILED — ${e.shortMessage?.slice(0,80)}`);
  }
}

console.log(`\n=== 3. V4 USDG/ETH Pool (direct ETH→USDG) ===`);
const v4EthPoolId = '0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32';
const V4_PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
try {
  const pm = new Contract(V4_PM, V4_POOLMANAGER_ABI, provider);
  const [sqrtP, tick] = await pm.getSlot0.staticCall(v4EthPoolId);
  const price = Number(sqrtP) ** 2 / 2 ** 192;
  console.log(`  sqrtPriceX96: ${sqrtP}`);
  console.log(`  tick: ${tick}`);
  console.log(`  price: ${price.toFixed(10)} USDG/ETH`);
} catch (e) {
  console.log(`  getSlot0 FAIL: ${e.shortMessage?.slice(0,80)}`);
}

console.log(`\n=== 4. Recommended Route ===`);
const bestUsdg = formatUnits(bestQuote.amountOut, USDG_DECIMALS);
console.log(`  Best V3 pool: ${bestQuote.pool.slice(0,14)} (fee=${bestQuote.fee/10000}%)`);
console.log(`  0.005 WETH → ${bestUsdg} USDG (${bestQuote.amountOut.toString()} raw units, 6 decimals)`);
console.log(`  Route: ETH → wrap → WETH → swap V3 pool → USDG`);
console.log(`  Note: USDG has 6 decimals (like USDC), so raw amounts are smaller than 18-decimals tokens`);

console.log('\n=== Done ===');
