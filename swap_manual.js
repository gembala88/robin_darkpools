import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256, AbiCoder, concat } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_SWAP_ROUTER_ABI, ERC20_ABI } from './abis.js';

const abi = AbiCoder.defaultAbiCoder();
const WETH = LP_V3_CASHCAT_WETH.token1;
const CASHCAT = LP_V3_CASHCAT_WETH.token0;

const WETH_ABI = [
  'function deposit() payable',
  'function approve(address guy, uint256 wad) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

async function main() {
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const addr = wallet.address;

  const amount = parseEther(process.env.AMOUNT_ETH || '0.005');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const weth = new Contract(WETH, WETH_ABI, wallet);
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);

  // Ensure approval
  const allowance = await weth.allowance(addr, V3.swapRouter02);
  if (allowance < amount) {
    console.log('Approving router...');
    const appTx = await weth.approve(V3.swapRouter02, MaxUint256);
    await appTx.wait();
  }

  // Quote
  const quoter = new Contract(V3.quoterV2, [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ], provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall([WETH, CASHCAT, amount, 10000, 0]);
  const amountOutMin = amountOut - (amountOut * 1n) / 100n;
  console.log(`Quote: ${formatEther(amount)} WETH → ${formatEther(amountOut)} CASHCAT`);
  console.log(`Min out: ${formatEther(amountOutMin)} CASHCAT`);

  // Approach 1: exactInput (single hop via bytes path)
  console.log('\n--- Approach 1: exactInput ---');
  const path = concat([WETH, abi.encode(['uint24'], [10000]), CASHCAT]);
  try {
    const tx1 = await router.exactInput(
      [path, addr, deadline, amount, amountOutMin],
      { value: 0n, gasLimit: 500000 }
    );
    const r1 = await tx1.wait();
    console.log(`Status: ${r1.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    if (r1.status === 1) {
      const bal = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(addr);
      console.log(`CASHCAT: ${formatEther(bal)}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`exactInput failed: ${e.shortMessage || e.message}`);
  }

  // Approach 2: exactInputSingle as array (not object)
  console.log('\n--- Approach 2: exactInputSingle (array params) ---');
  try {
    const swapParams = [WETH, CASHCAT, 10000, addr, deadline, amount, amountOutMin, 0n];
    const tx2 = await router.exactInputSingle(swapParams, { value: 0n, gasLimit: 500000 });
    const r2 = await tx2.wait();
    console.log(`Status: ${r2.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    if (r2.status === 1) {
      const bal = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(addr);
      console.log(`CASHCAT: ${formatEther(bal)}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`exactInputSingle failed: ${e.shortMessage || e.message}`);
  }

  // Approach 3: multicall wrapping exactInputSingle
  console.log('\n--- Approach 3: multicall ---');
  try {
    const swapData = router.interface.encodeFunctionData('exactInputSingle', [
      [WETH, CASHCAT, 10000, addr, deadline, amount, amountOutMin, 0n]
    ]);
    const tx3 = await router.multicall([swapData], { gasLimit: 500000 });
    const r3 = await tx3.wait();
    console.log(`Status: ${r3.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    if (r3.status === 1) {
      const bal = await new Contract(CASHCAT, ERC20_ABI, provider).balanceOf(addr);
      console.log(`CASHCAT: ${formatEther(bal)}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`multicall failed: ${e.shortMessage || e.message}`);
  }

  console.log('\nAll approaches failed');
}

main().catch(e => console.error('FATAL:', e.shortMessage || e.message));
