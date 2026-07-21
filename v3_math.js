// v3_math.js — Uniswap V3 exact math (TickMath + liquidity↔amounts)
// Uses BigInt fixed-point arithmetic, NO floating-point approximations.
import { UC } from './config.js';

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const RESOLUTION = 128;

// ===== TICKMATH.getSqrtRatioAtTick (exact, no floating point) =====
// Reference: Uniswap V3 TickMath.sol
const TICK_MAX = 887272;
const TICK_MIN = -887272;

const ZERO = 0n;
const ONE = 1n;

// Pre-computed: Q128 * [1/1.0001^(1/2)]^(bit)
const SCALE = 0x100000000000000000000000000000000n; // Q128 = 2^128

const MAGIC = [
  [0x1n,                   0xfffcb933bd6fad37aa2d162d1a594001n],
  [0x2n,                   0xfff97272373d413259a46990580e213an],
  [0x4n,                   0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n,                   0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n,                  0xffcb9843d60f6159c9db58835c926644n],
  [0x20n,                  0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n,                  0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n,                  0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n,                 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n,                 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n,                 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n,                 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n,                0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n,                0xa9f746462f870c57b7e5b2ef00b3c7e0n],
  [0x4000n,                0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n,                0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n,               0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n,               0x5d6af8dedb81196699c329225ee604n],
  [0x40000n,               0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n,               0x48a170391f7dc42444e8fa2n],
];

export function getSqrtRatioAtTick(tick) {
  tick = BigInt(tick);
  if (tick < TICK_MIN || tick > TICK_MAX) throw new Error(`tick ${tick} out of range`);
  const tickAbs = tick < 0n ? -tick : tick;
  let ratio = tickAbs & 0x1n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  for (const [bit, value] of MAGIC) {
    if (tickAbs & bit) {
      ratio = (ratio * value) >> 128n;
    }
  }
  if (tick > 0n) {
    const MAX_UINT256 = (1n << 256n) - 1n;
    ratio = MAX_UINT256 / ratio;
  }
  return ratio >> 32n;
}

// ===== GET AMOUNTS FOR LIQUIDITY =====
// Returns { amount0, amount1 } (as BigInts in token decimals)
export function getAmountsForLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  liquidity = BigInt(liquidity);
  sqrtPriceX96 = BigInt(sqrtPriceX96);
  const sqrtPL = getSqrtRatioAtTick(tickLower);
  const sqrtPU = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= sqrtPL) {
    // Below range — all token0
    const amount0 = liquidity * Q96 * (sqrtPU - sqrtPL) / (sqrtPL * sqrtPU);
    return { amount0, amount1: 0n };
  }
  if (sqrtPriceX96 >= sqrtPU) {
    // Above range — all token1
    const amount1 = liquidity * (sqrtPU - sqrtPL) / Q96;
    return { amount0: 0n, amount1 };
  }
  // In range
  const amount0 = liquidity * Q96 * (sqrtPU - sqrtPriceX96) / (sqrtPriceX96 * sqrtPU);
  const amount1 = liquidity * (sqrtPriceX96 - sqrtPL) / Q96;
  return { amount0, amount1 };
}

// ===== TICK → PRICE (token1 per token0) =====
// Returns a JavaScript Number (float, approximate — sufficient for USD display)
export function tickToPrice(tick) {
  tick = Number(tick);
  return 1.0001 ** tick;
}

// ===== SQRT PRICE X96 → PRICE (token1 per token0) =====
// Returns a BigInt scaled by 1e18 (for USD calculations)
export function sqrtPriceX96ToPrice(sqrtPriceX96) {
  sqrtPriceX96 = BigInt(sqrtPriceX96);
  const Q192 = Q96 * Q96;
  return sqrtPriceX96 * sqrtPriceX96;  // in Q192
}

// ===== USD PRICE HELPERS =====
const WETH_ADDR = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

let _ethUsdPrice = process.env.ETH_USD_PRICE ? Number(process.env.ETH_USD_PRICE) : null;
let _ethUsdAt = 0;

export async function getEthUsdPrice() {
  const now = Date.now();
  if (_ethUsdPrice !== null && now - _ethUsdAt < 120000) return _ethUsdPrice;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    if (j?.ethereum?.usd) { _ethUsdPrice = j.ethereum.usd; _ethUsdAt = now; }
  } catch { /* keep existing */ }
  return _ethUsdPrice;
}

export function getWethUsdPrice() {
  const cfgFallback = (() => { try { return UC('fallbackEthUsdPrice'); } catch { return null; } })();
  return _ethUsdPrice || Number(process.env.ETH_USD_PRICE || cfgFallback || '3000');
}

// Derive token0/token1 USD prices from pool tick + ETH price.
// Returns { token0Usd, token1Usd } or null if cannot derive (e.g. no WETH in pair).
export function getTokenUsdPricesFromTick(token0, token1, currentTick) {
  const ethUsd = getWethUsdPrice();
  if (!ethUsd) return null;
  const t0l = token0.toLowerCase();
  const t1l = token1.toLowerCase();
  if (t1l === WETH_ADDR) {
    const price = tickToPrice(currentTick);
    return { token0Usd: price * ethUsd, token1Usd: ethUsd };
  }
  if (t0l === WETH_ADDR) {
    const price = tickToPrice(currentTick);
    const token1PerWeth = 1.0 / price;
    return { token0Usd: ethUsd, token1Usd: ethUsd * token1PerWeth };
  }
  return null;
}
