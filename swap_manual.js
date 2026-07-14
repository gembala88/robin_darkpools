import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256 } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_SWAP_ROUTER_ABI, ERC20_ABI } from './abis.js';

const WETH = LP_V3_CASHCAT_WETH.token1;
const CASHCAT = LP_V3_CASHCAT_WETH.token0;

const WETH_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function approve(address guy, uint256 wad) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

async function main() {
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const addr = wallet.address;

  const amount = parseEther(process.env.AMOUNT_ETH || '0.005');
  const slippagePct = BigInt(process.env.SLIPPAGE_PCT || '1');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const weth = new Contract(WETH, WETH_ABI, wallet);
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);
  const cashcat = new Contract(CASHCAT, ERC20_ABI, wallet);

  console.log(`Wallet: ${addr}`);
  console.log(`Amount: ${formatEther(amount)} ETH`);

  // 1. Wrap ETH → WETH
  console.log('\n--- Step 1: Wrap ETH → WETH ---');
  const wethBalBefore = await weth.balanceOf(addr);
  console.log(`WETH before: ${formatEther(wethBalBefore)}`);
  const wrapTx = await weth.deposit({ value: amount });
  console.log(`Wrap tx: ${wrapTx.hash}`);
  await wrapTx.wait();
  const wethBalAfter = await weth.balanceOf(addr);
  console.log(`WETH after: ${formatEther(wethBalAfter)}`);

  // 2. Approve SwapRouter02
  console.log('\n--- Step 2: Approve SwapRouter02 ---');
  const allowance = await weth.allowance(addr, V3.swapRouter02);
  console.log(`Allowance before: ${formatEther(allowance)}`);
  if (allowance < amount) {
    const appTx = await weth.approve(V3.swapRouter02, MaxUint256);
    console.log(`Approve tx: ${appTx.hash}`);
    await appTx.wait();
    console.log('Approved.');
  }

  // 3. Quote swap
  console.log('\n--- Step 3: Quote WETH → CASHCAT ---');
  const quoter = new Contract(V3.quoterV2, [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ], provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall([WETH, CASHCAT, amount, 10000, 0]);
  const amountOutMin = amountOut - (amountOut * slippagePct) / 100n;
  console.log(`Expected: ${formatEther(amount)} WETH → ${formatEther(amountOut)} CASHCAT`);
  console.log(`Min (${slippagePct}% slip): ${formatEther(amountOutMin)} CASHCAT`);

  // 4. Execute swap
  console.log('\n--- Step 4: Execute swap ---');
  const swapParams = {
    tokenIn: WETH,
    tokenOut: CASHCAT,
    fee: 10000,
    recipient: addr,
    deadline,
    amountIn: amount,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  };

  const swapTx = await router.exactInputSingle(swapParams, { value: 0n });
  console.log(`Swap tx: ${swapTx.hash}`);
  const receipt = await swapTx.wait();
  console.log(`Status: ${receipt.status === 1 ? 'SUCCESS' : 'FAILED'}`);

  // If direct call failed, try multicall
  if (receipt.status === 0) {
    console.log('\nDirect call failed — retrying via multicall...');
    const swapData = router.interface.encodeFunctionData('exactInputSingle', [swapParams]);
    const tx2 = await router.multicall([swapData]);
    const r2 = await tx2.wait();
    console.log(`Multicall status: ${r2.status === 1 ? 'SUCCESS' : 'FAILED'}`);
  }

  // 5. Check balances
  console.log('\n--- Final Balances ---');
  const wethBal = await weth.balanceOf(addr);
  const cashcatBal = await cashcat.balanceOf(addr);
  console.log(`WETH: ${formatEther(wethBal)}`);
  console.log(`CASHCAT: ${formatEther(cashcatBal)}`);
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
