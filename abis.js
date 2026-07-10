// abis.js — ABIs (extracted from RobinFun bundle + Uniswap v4) and the V4
// Universal Router command encoder for swaps.

import { AbiCoder, concat, getBytes } from 'ethers';
import { POOL_KEY, NATIVE } from './config.js';

const abi = AbiCoder.defaultAbiCoder();

// --- RobinFun bonding-curve router (verified from frontend bundle) ---
export const CURVE_ABI = [
  'function buy(address token, uint256 minTokensOut) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minEthOut) returns (uint256 ethOut)',
  'function quoteBuy(address token, uint256 ethIn) view returns (uint256 tokensOut)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 ethOut)',
  'function currentPrice(address token) view returns (uint256)',
  'function curves(address) view returns (uint256 virtualEth, uint256 realEth, uint256 tokenReserve, uint256 raiseTarget, uint256 lpEth, uint256 tradingFeeBps)',
];

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

export const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];

export const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

// V4 Quoter — state-mutating (revert-based) but callable via eth_call.
export const QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
];

export const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

// --- Universal Router V4 command/action constants ---
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const POOLKEY_TUPLE = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

// Build execute() args for a V4 exact-input single swap on pool `key` (defaults
// to the first configured pool).
// zeroForOne=true  => spend currency0 (ETH) to get currency1 (RH6900)  [BUY on V4]
// zeroForOne=false => spend currency1 (RH6900) to get currency0 (ETH)  [SELL on V4]
export function buildV4Swap({ zeroForOne, amountIn, amountOutMin, deadline, key = POOL_KEY }) {
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  const inputCurrency = zeroForOne ? key.currency0 : key.currency1;
  const outputCurrency = zeroForOne ? key.currency1 : key.currency0;

  const actions = getBytes(
    '0x' + [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
      .map(b => b.toString(16).padStart(2, '0')).join('')
  );

  const swapParams = abi.encode(
    [`tuple(${POOLKEY_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
    [[keyTuple, zeroForOne, amountIn, amountOutMin, '0x']]
  );
  const settleAll = abi.encode(['address', 'uint256'], [inputCurrency, amountIn]);
  const takeAll   = abi.encode(['address', 'uint256'], [outputCurrency, amountOutMin]);

  const v4Input = abi.encode(['bytes', 'bytes[]'], [actions, [swapParams, settleAll, takeAll]]);
  const commands = '0x' + CMD_V4_SWAP.toString(16).padStart(2, '0');

  // If we spend native ETH (BUY), execute() must carry msg.value = amountIn.
  const value = zeroForOne ? amountIn : 0n;
  return { commands, inputs: [v4Input], deadline, value };
}
