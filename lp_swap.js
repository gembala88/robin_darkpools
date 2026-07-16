// lp_swap.js — Three-sided LP swap module.
// Wraps all ETH→WETH first, then splits:
//   - WETH→CASHCAT via V3 (for V3 CASHCAT/WETH LP)
//   - WETH→USDG via V3 (for V4 CASHCAT/USDG LP)
//   - remainder kept as WETH (for V3 CASHCAT/WETH LP)
//   DRY=1 node lp_swap.js           # simulate
//   DRY=0 PRIVATE_KEY=0x.. node lp_swap.js   # execute
//   AMOUNT_CASHCAT_ETH=0.005 AMOUNT_USDG_ETH=0.005 AMOUNT_WETH_ETH=0.005 DRY=0 node lp_swap.js

import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, formatUnits } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG } from './config.js';
import { V3_SWAP_ROUTER_ABI, V3_QUOTERV2_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';

const WETH_ABI = ['function deposit() payable', 'function withdraw(uint256)'];
const CFG = { dry: process.env.DRY !== '0', live: process.env.DRY === '0' };

const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const WETH = LP_V3_CASHCAT_WETH.token1;
const USDG = LP_V4_CASHCAT_USDG.key.currency1;
const USDG_DECIMALS = 6;
const USDG_POOL_FEE = 100; // 0.01% — best rate from route verification

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  const amountCashcatEth = parseEther(String(process.env.AMOUNT_CASHCAT_ETH || UC('lp.lpAmountEthCashcat')));
  const amountWethEth = parseEther(String(process.env.AMOUNT_WETH_ETH || UC('lp.lpAmountEthWeth')));
  const amountUsdgEth = parseEther(String(process.env.AMOUNT_USDG_ETH || UC('lp.lpAmountEthUsdg')));
  const slippagePct = BigInt(process.env.SLIPPAGE_PCT || UC('lp.slippagePct'));
  const totalEth = amountCashcatEth + amountWethEth + amountUsdgEth;

  console.log(`\n=== THREE-SIDED LP SWAP ===`);
  console.log(`ETH→WETH (wrap total): ${formatEther(totalEth)} ETH`);
  console.log(`  CASHCAT leg: ${formatEther(amountCashcatEth)} ETH`);
  console.log(`  USDG leg:    ${formatEther(amountUsdgEth)} ETH`);
  console.log(`  WETH leg:    ${formatEther(amountWethEth)} ETH`);

  // Quote CASHCAT
  const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);
  const [cashcatExpected] = await quoter.quoteExactInputSingle.staticCall([WETH, CASHCAT, amountCashcatEth, 10000, 0]);
  const cashcatMin = cashcatExpected - (cashcatExpected * slippagePct) / 100n;
  console.log(`\n  CASHCAT quote: ${formatEther(amountCashcatEth)} WETH → ${formatEther(cashcatExpected)} CASHCAT`);
  console.log(`  CASHCAT min (${slippagePct}% slip): ${formatEther(cashcatMin)}`);

  // Quote USDG (6 decimals)
  const [usdgExpected] = await quoter.quoteExactInputSingle.staticCall([WETH, USDG, amountUsdgEth, USDG_POOL_FEE, 0]);
  const usdgMin = usdgExpected - (usdgExpected * slippagePct) / 100n;
  const usdgHuman = formatUnits(usdgExpected, USDG_DECIMALS);
  console.log(`\n  USDG quote: ${formatEther(amountUsdgEth)} WETH → ${usdgHuman} USDG`);
  console.log(`  USDG min (${slippagePct}% slip): ${formatUnits(usdgMin, USDG_DECIMALS)}`);

  if (CFG.dry || !process.env.PRIVATE_KEY) {
    console.log('\nDRY-RUN: no tx sent. Set DRY=0 PRIVATE_KEY=0x.. to execute.');
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

  // Step 2: Approve router for WETH (full amount needed for both swaps)
  const totalWethNeeded = amountCashcatEth + amountUsdgEth;
  console.log('\n--- Step 2: Approve WETH for SwapRouter02 ---');
  if ((await weth.allowance(wallet.address, V3.swapRouter02)) < totalWethNeeded) {
    const appTx = await weth.approve.populateTransaction(V3.swapRouter02, totalWethNeeded);
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
  const swapCashcatParams = [WETH, CASHCAT, 10000, wallet.address, amountCashcatEth, cashcatMin, 0n];
  const swapCashcatPop = await router.exactInputSingle.populateTransaction(swapCashcatParams);
  const swapCashcatGas = await wallet.estimateGas(swapCashcatPop);
  console.log(`  Est gas: ${swapCashcatGas}`);
  const swapCashcatTx = await wallet.sendTransaction(swapCashcatPop);
  console.log(`  Tx: ${swapCashcatTx.hash}`);
  const swapCashcatRc = await swapCashcatTx.wait();
  console.log(`  Status: ${swapCashcatRc.status === 1 ? 'OK' : 'FAIL'}`);

  // Step 4: Swap WETH → USDG
  console.log('\n--- Step 4: Swap WETH→USDG via V3 ---');
  const swapUsdgParams = [WETH, USDG, USDG_POOL_FEE, wallet.address, amountUsdgEth, usdgMin, 0n];
  const swapUsdgPop = await router.exactInputSingle.populateTransaction(swapUsdgParams);
  const swapUsdgGas = await wallet.estimateGas(swapUsdgPop);
  console.log(`  Est gas: ${swapUsdgGas}`);
  const swapUsdgTx = await wallet.sendTransaction(swapUsdgPop);
  console.log(`  Tx: ${swapUsdgTx.hash}`);
  const swapUsdgRc = await swapUsdgTx.wait();
  console.log(`  Status: ${swapUsdgRc.status === 1 ? 'OK' : 'FAIL'}`);

  // Final balances
  const cashcatBal = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(wallet.address);
  const wethBal = await weth.balanceOf(wallet.address);
  const usdgBal = await new Contract(USDG, ERC20_ABI, provider).balanceOf(wallet.address);
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`\n=== FINAL BALANCES ===`);
  console.log(`  CASHCAT: ${formatEther(cashcatBal)}`);
  console.log(`  USDG:    ${formatUnits(usdgBal, USDG_DECIMALS)}`);
  console.log(`  WETH:    ${formatEther(wethBal)}`);
  console.log(`  ETH:     ${formatEther(ethBal)}`);
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });