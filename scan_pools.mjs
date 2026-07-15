import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes } from 'ethers';
const c = AbiCoder.defaultAbiCoder();
const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

const s0 = dataSlice(keccak256(toUtf8Bytes('getSlot0(bytes32)')), 0, 4);
const liq = dataSlice(keccak256(toUtf8Bytes('getLiquidity(bytes32)')), 0, 4);
const initSig = dataSlice(keccak256(toUtf8Bytes('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')), 0, 4);

// Get recent Initialize events from PoolManager
const initTopic = keccak256(toUtf8Bytes('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
const latest = await p.getBlockNumber();
console.log('Latest:', latest);

// Try small ranges for getLogs (Alchemy free tier: max 10 blocks)
for (let start = Math.max(0, latest - 10); start < latest; start += 3) {
  const end = Math.min(start + 2, latest);
  const filter = { address: PM, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16), topics: [initTopic] };
  try {
    const logs = await p.getLogs(filter);
    if (logs.length > 0) {
      for (const log of logs) {
        const pid = log.topics[1];
        // Decode the data to get pool key
        const decoded = c.decode(['address', 'address', 'uint24', 'int24', 'address', 'uint160', 'int24'], log.data);
        const [c0, c1, fee, ts, hooks, sqrtP, tick] = decoded;
        console.log(`\nPool init at block ${log.blockNumber}:`);
        console.log(`  poolId: ${pid}`);
        console.log(`  currency0: ${c0}`);
        console.log(`  currency1: ${c1}`);
        console.log(`  fee: ${fee}, tickSpacing: ${ts}`);
        
        // Check liquidity
        try {
          const r = await p.call({ to: SV, data: liq + c.encode(['bytes32'], [pid]).slice(2) });
          const [l] = c.decode(['uint128'], r);
          console.log(`  liquidity: ${l}`);
        } catch { console.log('  liquidity: ERROR'); }

        // Check slot0
        try {
          const r2 = await p.call({ to: SV, data: s0 + c.encode(['bytes32'], [pid]).slice(2) });
          const [sqrtP2, tick2] = c.decode(['uint160', 'int24', 'uint24', 'uint24'], r2);
          console.log(`  sqrtPrice: ${sqrtP2}, tick: ${tick2}`);
          const Q96 = 1n << 96n;
          const price1 = Number(BigInt(sqrtP2) * BigInt(sqrtP2) * 1000000n / (Q96 * Q96)) / 1000000;
          console.log(`  approx price: token1 = ${price1} token0`);
        } catch { console.log('  slot0: ERROR'); }
      }
    }
  } catch { /* rate limited */ }
}

process.exit(0);
