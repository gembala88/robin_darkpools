// test_tp_usd.mjs — Test USD-based trailing take-profit calculation
// Usage: node test_tp_usd.mjs [tokenId]
// Default tokenId: 224969 (CASHCAT/WETH V3)
// Uses on-chain data + CoinGecko ETH price.

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, formatUnits, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { V3 } from './config.js';
import { V3_NFPM_ABI } from './abis.js';
import {
  getAmountsForLiquidity, getSqrtRatioAtTick,
  getEthUsdPrice, getTokenUsdPricesFromTick, tickToPrice
} from './v3_math.js';

const TOKEN_ID = process.argv[2] || '224969';
const provider = await makeProvider('LP_RPC_URL');

console.log(`\n=== USD TP Test: Position #${TOKEN_ID} ===\n`);

// 1) Fetch position from NFPM
const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, provider);
let pos;
try {
  pos = await nfpm.positions.staticCall(BigInt(TOKEN_ID));
} catch (e) {
  console.error(`Position #${TOKEN_ID} not found: ${e.shortMessage || e.message}`);
  process.exit(1);
}

const [nonce, operator, token0, token1, fee, tickLowerNum, tickUpperNum, liquidity, fg0, fg1, tokensOwed0, tokensOwed1] = pos;
const tickLower = Number(tickLowerNum);
const tickUpper = Number(tickUpperNum);

console.log(`Token0: ${token0}`);
console.log(`Token1: ${token1}`);
console.log(`Fee: ${fee}`);
console.log(`Liquidity: ${formatUnits(liquidity, 18)}`);
console.log(`Tick range: ${tickLower} → ${tickUpper}`);
console.log(`Tokens owed0: ${formatUnits(tokensOwed0, 18)}`);
console.log(`Tokens owed1: ${formatEther(tokensOwed1)}`);
console.log('');

// 2) Get pool slot0
const factory = new Contract(V3.factory, ['function getPool(address,address,uint24) view returns (address)'], provider);
let poolAddr;
try { poolAddr = await factory.getPool(token0, token1, fee); } catch {}
if (!poolAddr || poolAddr === '0x0000000000000000000000000000000000000000') {
  console.error('Could not resolve pool address');
  process.exit(1);
}
console.log(`Pool: ${poolAddr}`);

const poolContract = new Contract(poolAddr, [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
], provider);
const slot0 = await poolContract.slot0();
const sqrtPriceX96 = BigInt(slot0[0]);
const currentTick = Number(slot0[1]);
const price = tickToPrice(currentTick);
console.log(`Current tick: ${currentTick}, sqrtPriceX96: ${sqrtPriceX96}`);
console.log(`Current price (token1/token0): ${price.toExponential(6)}`);
console.log('');

// 3) Compute current amounts from liquidity
const { amount0: currAmount0, amount1: currAmount1 } = getAmountsForLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper);
console.log(`Current amounts from liquidity:`);
console.log(`  token0: ${formatUnits(currAmount0, 18)}`);
console.log(`  token1: ${formatEther(currAmount1)}`);
console.log(`  + tokensOwed0: ${formatUnits(tokensOwed0, 18)}`);
console.log(`  + tokensOwed1: ${formatEther(tokensOwed1)}`);
console.log('');

// 4) Get ETH/USD price
const ethUsd = await getEthUsdPrice();
console.log(`ETH/USD: \$${ethUsd}`);
console.log('');

// 5) Compute current USD value
const prices = getTokenUsdPricesFromTick(token0, token1, currentTick);
if (!prices) {
  console.error('Cannot derive USD prices (no WETH in pair)');
  process.exit(1);
}
console.log(`Derived prices:`);
console.log(`  token0 USD: \$${prices.token0Usd.toFixed(6)}`);
console.log(`  token1 USD: \$${prices.token1Usd.toFixed(2)}`);

const total0 = currAmount0 + tokensOwed0;
const total1 = currAmount1 + tokensOwed1;
const val0 = Number(formatUnits(total0, 18)) * prices.token0Usd;
const val1 = Number(formatEther(total1)) * prices.token1Usd;
const currentValueUsd = val0 + val1;
console.log(`\nCurrent USD value:`);
console.log(`  token0 portion: \$${val0.toFixed(2)}`);
console.log(`  token1 portion: \$${val1.toFixed(2)}`);
console.log(`  TOTAL: \$${currentValueUsd.toFixed(2)}`);
console.log('');

// 6) Estimate entry value (for TESTING only — uses same liquidity + entryTick from state)
//    For existing positions, we scan lp_state.json for entryTick + entryValueUsd
let entryValueUsd = null;
let entryTick = currentTick; // fallback
const stateFile = new URL('./lp_state.json', import.meta.url);
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const entry = state.positions?.find(p => p.tokenId === TOKEN_ID);
  if (entry) {
    if (entry.entryValueUsd) {
      entryValueUsd = entry.entryValueUsd;
      console.log(`entryValueUsd found in lp_state.json: \$${entryValueUsd}`);
    } else if (entry.entryTick) {
      entryTick = Number(entry.entryTick);
      console.log(`entryTick found in lp_state.json: ${entryTick} (no entryValueUsd — estimating)`);
    } else {
      console.log('No entryTick in lp_state.json — using current tick as entry (estimate)');
    }
  } else {
    console.log('Position not found in lp_state.json — using current tick as entry (estimate)');
  }
} catch {
  console.log('lp_state.json not found or invalid — using current tick as entry (estimate)');
}

if (!entryValueUsd) {
  // Estimate: compute amounts at entry tick (using SAME liquidity), then apply current USD prices
  const entrySqrtPrice = getSqrtRatioAtTick(entryTick);
  const { amount0: entryAmt0, amount1: entryAmt1 } = getAmountsForLiquidity(liquidity, entrySqrtPrice, tickLower, tickUpper);
  console.log(`Estimated entry amounts at tick ${entryTick}:`);
  console.log(`  token0: ${formatUnits(entryAmt0, 18)}`);
  console.log(`  token1: ${formatEther(entryAmt1)}`);
  const eVal0 = Number(formatUnits(entryAmt0, 18)) * prices.token0Usd;
  const eVal1 = Number(formatEther(entryAmt1)) * prices.token1Usd;
  entryValueUsd = eVal0 + eVal1;
  console.log(`Estimated entryValueUsd: \$${entryValueUsd.toFixed(2)}`);
  console.log(`  (token0 portion: \$${eVal0.toFixed(2)}, token1 portion: \$${eVal1.toFixed(2)})`);
}

// 7) Final result
if (entryValueUsd > 0) {
  const netProfitPct = ((currentValueUsd - entryValueUsd) / entryValueUsd) * 100;
  const gainLoss = netProfitPct >= 0 ? 'PROFIT' : 'LOSS';
  console.log(`\n========== RESULT ==========`);
  console.log(`Entry value: \$${entryValueUsd.toFixed(2)}`);
  console.log(`Current value: \$${currentValueUsd.toFixed(2)}`);
  console.log(`Net P&L: \$${(currentValueUsd - entryValueUsd).toFixed(2)}`);
  console.log(`Net profit: ${netProfitPct.toFixed(2)}% (${gainLoss})`);

  // TP simulation
  const TP_ARM = 7;
  const TP_TRAIL = 1;
  if (netProfitPct >= TP_ARM) {
    console.log(`  >> Take-profit ARMED at +${TP_ARM}% (currently +${netProfitPct.toFixed(1)}%)`);
    const stopLoss = currentValueUsd - (currentValueUsd * (TP_TRAIL / 100));
    console.log(`  >> Trail ${TP_TRAIL}% from peak: would trigger at \$${stopLoss.toFixed(2)}`);
  } else {
    console.log(`  >> Below arm threshold (+${TP_ARM}%). Need \$${(entryValueUsd * (1 + TP_ARM / 100)).toFixed(2)} to arm.`);
  }

  // SL simulation (IL-based, using exact formula from monitor)
  const { ilConcentrated } = await import('./lp_monitor.js');
  const ilPct = ilConcentrated(tickToPrice(entryTick), price, tickLower, tickUpper) * 100;
} else {
  console.log('\nCannot compute P&L — missing entry value');
}
