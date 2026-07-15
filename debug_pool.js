import 'dotenv/config';
import { Contract, Wallet, parseEther, formatEther, keccak256, toUtf8Bytes, dataSlice } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';

async function main() {
  const provider = await makeProvider();
  const router = V3.swapRouter02;

  // Check which functions exist on the router by checking their selectors
  const funcs = [
    'exactInputSingle',
    'exactInput',
    'multicall',
    'WETH9',
    'factory',
    'swap',
    'exactOutputSingle',
    'exactOutput',
    'uniswapV3SwapCallback',
    'unwrapWETH9',
    'refundETH',
    'sweepToken',
  ];

  console.log('=== Router function selector check ===');
  for (const fn of funcs) {
    const sig = `${fn}(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)`;
    const selector = dataSlice(keccak256(toUtf8Bytes(sig)), 0, 4);
    try {
      const code = await provider.getCode(router);
      const selectorHex = selector.replace('0x', '').toLowerCase();
      if (code.toLowerCase().includes(selectorHex)) {
        console.log(`  ✅ ${fn} — selector found`);
      } else {
        console.log(`  ❌ ${fn} — selector NOT found`);
      }
    } catch (e) {
      console.log(`  ? ${fn} — error: ${e.message}`);
    }
  }

  // Also check a few standard signatures
  const altSigs = [
    'exactInputSingle(tuple(address,address,uint24,address,uint256,uint256,uint256,uint160),uint256)',
    'exactInput(tuple(bytes,address,uint256,uint256,uint256))',
    'multicall(uint256,bytes[])',
    'multicall(bytes[],uint256)',
  ];
  console.log('\n=== Alternative signatures ===');
  for (const sig of altSigs) {
    const selector = dataSlice(keccak256(toUtf8Bytes(sig)), 0, 4);
    try {
      const code = await provider.getCode(router);
      const selectorHex = selector.replace('0x', '').toLowerCase();
      if (code.toLowerCase().includes(selectorHex)) {
        console.log(`  ✅ ${sig} — selector found`);
      } else {
        console.log(`  ❌ ${sig} — selector NOT found`);
      }
    } catch (e) {
      console.log(`  ? ${sig} — error: ${e.message}`);
    }
  }
}

main().catch(e => console.error('FATAL:', e.shortMessage || e.message));
