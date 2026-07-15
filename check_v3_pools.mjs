import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes } from 'ethers';
const c = AbiCoder.defaultAbiCoder();
const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');

const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const RH6900 = '0x45c2a2462e4ffc37e9698b46361f0f6444544663';

// Check if RH6900/WETH V3 pool exists for different fee tiers
const fees = [100, 500, 3000, 10000];
// getPool selector = keccak256('getPool(address,address,uint24)')
const getPool = dataSlice(keccak256(toUtf8Bytes('getPool(address,address,uint24)')), 0, 4);

console.log('Checking V3 pools for RH6900/WETH:');
for (const fee of fees) {
  // token0 should be the lower address
  const t0 = RH6900.toLowerCase() < WETH.toLowerCase() ? RH6900 : WETH;
  const t1 = RH6900.toLowerCase() < WETH.toLowerCase() ? WETH : RH6900;
  const data = getPool + c.encode(['address', 'address', 'uint24'], [t0, t1, fee]).slice(2);
  try {
    const r = await p.call({ to: V3_FACTORY, data });
    const pool = '0x' + r.slice(-40);
    if (pool !== '0x0000000000000000000000000000000000000000') {
      console.log(`  ${fee/10000}% fee: ${pool}`);
      // Check if pool has liquidity via slot0
      const slot0Sig = dataSlice(keccak256(toUtf8Bytes('slot0()')), 0, 4);
      try {
        const r2 = await p.call({ to: pool, data: slot0Sig });
        const [sqrtP, tick] = c.decode(['uint160', 'int24'], r2);
        // Check liquidity
        const liqSig = dataSlice(keccak256(toUtf8Bytes('liquidity()')), 0, 4);
        const r3 = await p.call({ to: pool, data: liqSig });
        const [liq] = c.decode(['uint128'], r3);
        console.log(`    sqrt: ${sqrtP}, tick: ${tick}, liq: ${liq}`);
      } catch { console.log('    No slot0'); }
    }
  } catch { /* pool doesn't exist */ }
}

// Also check CASHCAT/WETH V3 pools
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
console.log('\nChecking V3 pools for CASHCAT/WETH:');
for (const fee of fees) {
  const t0 = CASHCAT.toLowerCase() < WETH.toLowerCase() ? CASHCAT : WETH;
  const t1 = CASHCAT.toLowerCase() < WETH.toLowerCase() ? WETH : CASHCAT;
  const data = getPool + c.encode(['address', 'address', 'uint24'], [t0, t1, fee]).slice(2);
  try {
    const r = await p.call({ to: V3_FACTORY, data });
    const pool = '0x' + r.slice(-40);
    if (pool !== '0x0000000000000000000000000000000000000000') {
      console.log(`  ${fee/10000}% fee: ${pool}`);
      const slot0Sig = dataSlice(keccak256(toUtf8Bytes('slot0()')), 0, 4);
      try {
        const r2 = await p.call({ to: pool, data: slot0Sig });
        const [sqrtP, tick] = c.decode(['uint160', 'int24'], r2);
        const liqSig = dataSlice(keccak256(toUtf8Bytes('liquidity()')), 0, 4);
        const r3 = await p.call({ to: pool, data: liqSig });
        const [liq] = c.decode(['uint128'], r3);
        console.log(`    sqrt: ${sqrtP}, tick: ${tick}, liq: ${liq}`);
      } catch { console.log('    No slot0'); }
    }
  } catch { /* pool doesn't exist */ }
}

process.exit(0);
