import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, MaxUint256 } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';
import { V3_SWAP_ROUTER_ABI, ERC20_ABI } from './abis.js';

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

  // Use the 0.02 WETH we already have (from previous wraps)
  // Don't wrap more — use existing WETH
  const amount = parseEther('0.01'); // use 0.01 of the 0.02 WETH we have
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const router = new Contract(V3.swapRouter02, V3_SWAP_ROUTER_ABI, wallet);

  // Verify we still have approval
  const weth = new Contract(WETH, WETH_ABI, wallet);
  const allowance = await weth.allowance(addr, V3.swapRouter02);
  console.log(`Allowance OK: ${allowance > 0n}`);

  // Quote
  const quoter = new Contract(V3.quoterV2, [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ], provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall([WETH, CASHCAT, amount, 10000, 0]);
  const amountOutMin = amountOut - (amountOut * 1n) / 100n;
  console.log(`Quote: ${formatEther(amount)} WETH → ${formatEther(amountOut)} CASHCAT`);
  console.log(`Min out: ${formatEther(amountOutMin)} CASHCAT`);

  // Approach A: exactInputSingle with msg.value = amount
  console.log('\n--- Approach A: exactInputSingle + msg.value ---');
  try {
    const gasEst = await router.exactInputSingle.estimateGas(
      [WETH, CASHCAT, 10000, addr, deadline, amount, amountOutMin, 0n],
      { value: amount }
    );
    console.log(`Gas est: ${gasEst}`);
    const tx = await router.exactInputSingle(
      [WETH, CASHCAT, 10000, addr, deadline, amount, amountOutMin, 0n],
      { value: amount, gasLimit: gasEst * 120n / 100n }
    );
    const r = await tx.wait();
    if (r.status === 1) {
      console.log('SUCCESS');
      const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
      console.log(`CASHCAT: ${formatEther(await cashcat.balanceOf(addr))}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`Approach A failed: ${e.shortMessage || e.message}`);
  }

  // Approach B: exactInputSingle without msg.value (but with amount out = 0 to test)
  console.log('\n--- Approach B: exactInputSingle, no value, minOut=0 ---');
  try {
    const tx = await router.exactInputSingle(
      [WETH, CASHCAT, 10000, addr, deadline, amount, 0n, 0n],
      { value: 0n, gasLimit: 500000 }
    );
    const r = await tx.wait();
    console.log(`Status: ${r.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    if (r.status === 1) {
      const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
      console.log(`CASHCAT: ${formatEther(await cashcat.balanceOf(addr))}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`Approach B failed: ${e.shortMessage || e.message}`);
  }

  // Approach C: Try calling the local `exactInputSingle` on the router via eth_estimateGas to get revert reason
  console.log('\n--- Approach C: estimateGas to get revert reason ---');
  try {
    await router.exactInputSingle.estimateGas(
      [WETH, CASHCAT, 10000, addr, deadline, amount, amountOutMin, 0n],
      { value: 0n }
    );
  } catch (e) {
    console.log(`Revert reason: ${e.reason || e.shortMessage || e.message}`);
    // ethers v6 sometimes puts revert data in e.data or e.info
    if (e.info?.error?.message) console.log(`Error msg: ${e.info.error.message}`);
    if (e.code === 'CALL_EXCEPTION') console.log(`CALL_EXCEPTION data: ${e.data}`);
  }

  console.log('\nAll approaches failed');
}

main().catch(e => console.error('FATAL:', e.shortMessage || e.message));
