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
// Reverts with QuoteSwap(uint256 amountOut) — we catch and decode in arb.js.
export const QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params)',
];

export const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

// --- V3 SwapRouter02 ABI (verified from Blockscout — Robinhood Chain fork) ---
// NOTE: The Robinhood fork uses a non-standard IV3SwapRouter with no `deadline`
// in ExactInputSingleParams or ExactInputParams. All structs omit `deadline`.
export const V3_SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)',
  'function WETH9() view returns (address)',
  'function factory() view returns (address)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
];

// --- V3 QuoterV2 ABI (for simulations) ---
export const V3_QUOTERV2_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// --- V3 NFPM ABI (standard Uniswap V3) ---
export const V3_NFPM_ABI = [
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function factory() view returns (address)',
];

// --- V4 NFPM ABI (custom Robinhood fork, verified on Blockscout) ---
export const V4_NFPM_ABI = [
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function modifyLiquiditiesWithoutUnlock(bytes actions, bytes[] params) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
];

// V4 PoolManager minimal ABI for slot0/liquidity queries
export const V4_POOLMANAGER_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
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
