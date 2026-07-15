// lp_swap.js — Two-sided LP swap module.
// Swaps ETH → CASHCAT (V3) + wraps ETH → WETH (WETH.deposit).
//   DRY=1 node lp_swap.js   # simulate
//   LIVE=1 PRIVATE_KEY=0x.. node lp_swap.js   # execute real tx

import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH, NATIVE } from './config.js';
import { V3_SWAP_ROUTER_ABI, V3_QUOTERV2_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';

const abi = AbiCoder.defaultAbiCoder();
const WETH_ABI = ['function deposit() payable', 'function withdraw(uint256)'];
const CFG = {
  dry: process.env.DRY !== '0',
  live: process.env.LIVE === '1',
};

const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const WETH = LP_V3_CASHCAT_WETH.token1;

async function simulateV3Swap(provider, ethAmount) {
  const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);
  const params = [WETH, CASHCAT, ethAmount, 10000, 0];
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall(params);
  console.log(`  V3 swap: ${formatEther(ethAmount)} ETH → ${formatEther(amountOut)} CASHCAT`);
  return amountOut;
}

async function buildV3SwapTx(wallet, ethAmount, cashcatAmountMin) {
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);
  const params = [NATIVE, CASHCAT, 10000, wallet.address, ethAmount, cashcatAmountMin, 0n];
  const tx = await router.exactInputSingle.populateTransaction(params);
  tx.value = ethAmount;
  return tx;
}

async function main() {
  const provider = await makeProvider();
  const amountCashcatEth = parseEther(String(process.env.AMOUNT_CASHCAT_ETH || UC('lp.lpAmountEthCashcat')));
  const amountWethEth = parseEther(String(process.env.AMOUNT_WETH_ETH || UC('lp.lpAmountEthWeth')));
  const slippagePct = BigInt(process.env.SLIPPAGE_PCT || UC('lp.slippagePct'));
  const totalEth = amountCashcatEth + amountWethEth;

  console.log(`\n=== TWO-SIDED LP SWAP ===`);
  console.log(`ETH→CASHCAT: ${formatEther(amountCashcatEth)} ETH`);
  console.log(`ETH→WETH (wrap): ${formatEther(amountWethEth)} ETH`);
  console.log(`Total ETH needed: ${formatEther(totalEth)}`);

  // Simulate V3 swap for CASHCAT
  const cashcatExpected = await simulateV3Swap(provider, amountCashcatEth);
  const cashcatMin = cashcatExpected - (cashcatExpected * slippagePct) / 100n;
  console.log(`  CASHCAT min (${slippagePct}% slip): ${formatEther(cashcatMin)}`);

  if (!CFG.live || !process.env.PRIVATE_KEY) {
    console.log('\nDRY-RUN: no tx sent. Set LIVE=1 PRIVATE_KEY=0x.. to execute.');
    process.exit(0);
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`\nWallet: ${wallet.address}`);
  const weth = new Contract(WETH, WETH_ABI, wallet);

  // Step 1: Swap ETH → CASHCAT
  console.log('\n--- Step 1: Swap ETH→CASHCAT via V3 ---');
  const swapPop = await buildV3SwapTx(wallet, amountCashcatEth, cashcatMin);
  const swapGas = await wallet.estimateGas(swapPop);
  console.log(`  Estimated gas: ${swapGas}`);
  const swapTx = await wallet.sendTransaction(swapPop);
  console.log(`  Tx: ${swapTx.hash}`);
  const swapRc = await swapTx.wait();
  console.log(`  Status: ${swapRc.status === 1 ? '✅' : '❌'}`);

  // Step 2: Wrap ETH → WETH
  console.log('\n--- Step 2: Wrap ETH→WETH ---');
  const wrapTx = await weth.deposit({ value: amountWethEth });
  console.log(`  Tx: ${wrapTx.hash}`);
  const wrapRc = await wrapTx.wait();
  console.log(`  Status: ${wrapRc.status === 1 ? '✅' : '❌'}`);

  // Final balances
  const cashcatBal = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(wallet.address);
  const wethBal = await weth.balanceOf(wallet.address);
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`\n=== FINAL BALANCES ===`);
  console.log(`  CASHCAT: ${formatEther(cashcatBal)}`);
  console.log(`  WETH:    ${formatEther(wethBal)}`);
  console.log(`  ETH:     ${formatEther(ethBal)}`);
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
