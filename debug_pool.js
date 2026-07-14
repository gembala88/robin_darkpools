import 'dotenv/config';
import { Contract, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';

const WETH = LP_V3_CASHCAT_WETH.token1;
const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const POOL = LP_V3_CASHCAT_WETH.pool;

const POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
];

async function main() {
  const provider = await makeProvider();
  const pool = new Contract(POOL, POOL_ABI, provider);
  const router = new Contract(V3.swapRouter02, [
    'function WETH9() view returns (address)',
    'function factory() view returns (address)',
  ], provider);

  console.log('=== Pool Debug ===');
  const [t0, t1, fee, slot0, liq] = await Promise.all([
    pool.token0(), pool.token1(), pool.fee(), pool.slot0(), pool.liquidity(),
  ]);
  console.log(`token0: ${t0} (expected CASHCAT: ${CASHCAT})`);
  console.log(`token1: ${t1} (expected WETH: ${WETH})`);
  console.log(`fee: ${fee} (expected 10000)`);
  console.log(`sqrtPriceX96: ${slot0[0]}`);
  console.log(`tick: ${slot0[1]}`);
  console.log(`liquidity: ${liq}`);

  const routerWeth = await router.WETH9();
  const routerFactory = await router.factory();
  console.log(`\n=== Router Debug ===`);
  console.log(`WETH9(): ${routerWeth} (config WETH: ${WETH})`);
  console.log(`factory(): ${routerFactory} (config factory: ${V3.factory})`);

  // Check if router can find the pool
  const routerPoolAbi = ['function getPool(address,address,uint24) view returns (address)'];
  const factory = new Contract(V3.factory, routerPoolAbi, provider);
  const routerPool = await factory.getPool(CASHCAT, WETH, 10000);
  console.log(`\n=== Factory Check ===`);
  console.log(`getPool(CASHCAT, WETH, 10000): ${routerPool} (expected ${POOL})`);
  console.log(`Match: ${routerPool.toLowerCase() === POOL.toLowerCase()}`);
}

main().catch(e => console.error('FAILED:', e.shortMessage || e.message));
