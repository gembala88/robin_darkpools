// lp_swap.js — Auto-swap module for LP deposit (shared by V3 and V4 paths)
//   DRY=1 node lp_swap.js v3   # simulate V3 ETH→CASHCAT swap
//   DRY=1 node lp_swap.js v4   # simulate V4 ETH→USDG→CASHCAT path
//   LIVE=1 PRIVATE_KEY=0x.. node lp_swap.js v3   # execute real swap

import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG, NATIVE } from './config.js';
import { V3_SWAP_ROUTER_ABI, V3_QUOTERV2_ABI, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';

const abi = AbiCoder.defaultAbiCoder();
const CFG = {
  dry: process.env.DRY !== '0',
  live: process.env.LIVE === '1',
};

const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const WETH = LP_V3_CASHCAT_WETH.token1;
const USDG = LP_V4_CASHCAT_USDG.key.currency1;

async function simulateV3Swap(provider, ethAmount) {
  const quoter = new Contract(V3.quoterV2, V3_QUOTERV2_ABI, provider);
  const params = [WETH, CASHCAT, ethAmount, 10000, 0];
  const [amountOut, , , ] = await quoter.quoteExactInputSingle.staticCall(params);
  console.log(`  V3 QuoterV2: ${formatEther(ethAmount)} ETH → ${formatEther(amountOut)} CASHCAT`);
  return amountOut;
}

async function simulateV4Swap(provider, ethAmount) {
  // No direct ETH→CASHCAT V4 pool exists (V4 pool is CASHCAT/USDG).
  // Skip V4 swap — the V4 deposit path must use existing CASHCAT balance.
  console.log('  V4: no direct ETH→CASHCAT pool; skipping. Use V3 path or provide CASHCAT directly.');
  return 0n;
}

async function buildV3SwapTx(wallet, ethAmount, cashcatAmountMin) {
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);
  // FIXED: Robinhood fork's ExactInputSingleParams has NO deadline
  const params = [NATIVE, CASHCAT, 10000, wallet.address, ethAmount, cashcatAmountMin, 0n];
  const tx = await router.exactInputSingle.populateTransaction(params);
  tx.value = ethAmount;
  return tx;
}

async function buildV4SwapTx(wallet, ethAmount, cashcatAmountMin, deadline) {
  const key = LP_V4_CASHCAT_USDG.key;
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  const inputCurrency = NATIVE;
  const outputCurrency = key.currency0;

  const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
  const ACT_SETTLE_ALL = 0x0c;
  const ACT_TAKE_ALL = 0x0f;
  const CMD_V4_SWAP = 0x10;

  const actions = new Uint8Array([ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]);
  const POOLKEY_TUPLE = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

  const swapParams = abi.encode(
    [`tuple(${POOLKEY_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
    [[keyTuple, true, ethAmount, cashcatAmountMin, '0x']]
  );
  const settleAll = abi.encode(['address', 'uint256'], [inputCurrency, ethAmount]);
  const takeAll   = abi.encode(['address', 'uint256'], [outputCurrency, cashcatAmountMin]);

  const v4Input = abi.encode(['bytes', 'bytes[]'], [actions, [swapParams, settleAll, takeAll]]);
  const commands = '0x' + CMD_V4_SWAP.toString(16).padStart(2, '0');

  return { commands, inputs: [v4Input], deadline, value: ethAmount };
}

async function main() {
  const mode = process.argv[2];
  if (!['v3', 'v4'].includes(mode)) throw new Error('Usage: node lp_swap.js <v3|v4> [AMOUNT_ETH]');

  const provider = await makeProvider();
  const amountEth = parseEther(process.env.AMOUNT_ETH || String(UC('lp.lpSizeEthCashcat' + (mode === 'v3' ? 'Weth' : 'Usdg'))));
  const slippagePct = BigInt(process.env.SLIPPAGE_PCT || UC('lp.slippagePct'));

  console.log(`\n=== LP SWAP SIMULATION (${mode.toUpperCase()}) ===`);
  console.log(`Amount: ${formatEther(amountEth)} ETH`);

  let amountOut, amountOutMin;
  if (mode === 'v3') {
    amountOut = await simulateV3Swap(provider, amountEth);
  } else {
    amountOut = await simulateV4Swap(provider, amountEth);
  }
  amountOutMin = amountOut - (amountOut * slippagePct) / 100n;

  console.log(`Amount out min (${slippagePct}% slip): ${formatEther(amountOutMin)} CASHCAT`);

  if (!CFG.live || !process.env.PRIVATE_KEY) {
    console.log('\nDRY-RUN: no tx sent. Set LIVE=1 PRIVATE_KEY=0x.. to execute.');
    process.exit(0);
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`\nExecuting swap via wallet: ${wallet.address}`);

  let txData;
  if (mode === 'v3') {
    const pop = await buildV3SwapTx(wallet, amountEth, amountOutMin);
    const gas = await wallet.estimateGas(pop);
    console.log(`Estimated gas: ${gas}`);
    const tx = await wallet.sendTransaction(pop);
    console.log(`V3 Swap tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Status: ${receipt.status === 1 ? '✅' : '❌'}`);
  } else {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const { commands, inputs, deadline: dl, value } = await buildV4SwapTx(wallet, amountEth, amountOutMin, deadline);
    const router = new Contract(V4.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);
    const tx = await router.execute(commands, inputs, dl, { value });
    console.log(`V4 Swap tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Status: ${receipt.status === 1 ? '✅' : '❌'}`);
  }

  const balance = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(wallet.address);
  console.log(`CASHCAT balance: ${formatEther(balance)}`);
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
