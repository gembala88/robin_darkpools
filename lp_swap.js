// lp_swap.js — Two-sided LP swap module.
// Wraps all ETH→WETH first, then swaps WETH→CASHCAT via V3.
//   DRY=1 node lp_swap.js           # simulate
//   DRY=0 PRIVATE_KEY=0x.. node lp_swap.js   # execute (NOT LIVE=1 — decoupled from arb.js)
//   AMOUNT_CASHCAT_ETH=0.005 AMOUNT_WETH_ETH=0.005 DRY=0 node lp_swap.js

import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_SWAP_ROUTER_ABI, V3_QUOTERV2_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';

const WETH_ABI = ['function deposit() payable', 'function withdraw(uint256)'];
const CFG = { dry: process.env.DRY !== '0', live: process.env.DRY === '0' };

const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const WETH = LP_V3_CASHCAT_WETH.token1;

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  const amountCashcatEth = parseEther(String(process.env.AMOUNT_CASHCAT_ETH || UC('lp.lpAmountEthCashcat')));
  const amountWethEth = parseEther(String(process.env.AMOUNT_WETH_ETH || UC('lp.lpAmountEthWeth')));
  const slippagePct = BigInt(process.env.SLIPPAGE_PCT || UC('lp.slippagePct'));
  const totalEth = amountCashcatEth + amountWethEth;

  console.log(`\n=== TWO-SIDED LP SWAP ===`);
  console.log(`ETH→WETH (wrap total): ${formatEther(totalEth)} ETH`);
  console.log(`  of which CASHCAT leg: ${formatEther(amountCashcatEth)} ETH`);
  console.log(`  of which WETH leg: ${formatEther(amountWethEth)} ETH`);

  // Quote via V3 QuoterV2 (tokenIn=WETH, tokenOut=CASHCAT)
  const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);
  const [cashcatExpected] = await quoter.quoteExactInputSingle.staticCall([WETH, CASHCAT, amountCashcatEth, 10000, 0]);
  const cashcatMin = cashcatExpected - (cashcatExpected * slippagePct) / 100n;
  console.log(`\n  V3 quote: ${formatEther(amountCashcatEth)} WETH → ${formatEther(cashcatExpected)} CASHCAT`);
  console.log(`  CASHCAT min (${slippagePct}% slip): ${formatEther(cashcatMin)}`);

  if (CFG.dry || !process.env.PRIVATE_KEY) {
    console.log('\nDRY-RUN: no tx sent. Set DRY=0 PRIVATE_KEY=0x.. to execute (independent of arb LIVE flag).');
    process.exit(0);
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`\nWallet: ${wallet.address}`);
  const weth = new Contract(WETH, WETH_ABI, wallet);
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);

  // Step 1: Wrap ALL ETH → WETH
  console.log('\n--- Step 1: Wrap ETH→WETH ---');
  const wrapTx = await weth.deposit({ value: totalEth });
  console.log(`  Tx: ${wrapTx.hash}`);
  const wrapRc = await wrapTx.wait();
  console.log(`  Status: ${wrapRc.status === 1 ? 'OK' : 'FAIL'}`);

  // Step 2: Approve router for WETH
  console.log('\n--- Step 2: Approve WETH for SwapRouter02 ---');
  if ((await weth.allowance(wallet.address, V3.swapRouter02)) < amountCashcatEth) {
    const appTx = await weth.approve.populateTransaction(V3.swapRouter02, amountCashcatEth);
    const appGas = await wallet.estimateGas(appTx);
    console.log(`  Est gas: ${appGas}`);
    const appSent = await wallet.sendTransaction(appTx);
    console.log(`  Tx: ${appSent.hash}`);
    await appSent.wait();
  } else {
    console.log('  Already approved');
  }

  // Step 3: Swap WETH → CASHCAT
  console.log('\n--- Step 3: Swap WETH→CASHCAT via V3 ---');
  const swapParams = [WETH, CASHCAT, 10000, wallet.address, amountCashcatEth, cashcatMin, 0n];
  const swapPop = await router.exactInputSingle.populateTransaction(swapParams);
  const swapGas = await wallet.estimateGas(swapPop);
  console.log(`  Est gas: ${swapGas}`);
  const swapTx = await wallet.sendTransaction(swapPop);
  console.log(`  Tx: ${swapTx.hash}`);
  const swapRc = await swapTx.wait();
  console.log(`  Status: ${swapRc.status === 1 ? 'OK' : 'FAIL'}`);

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