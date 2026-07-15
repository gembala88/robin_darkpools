import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes, getAddress, id } from 'ethers';
const c = AbiCoder.defaultAbiCoder();
const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const RH6900 = '0x45c2a2462e4ffc37e9698b46361f0f6444544663'.toLowerCase();

const swapTopic = id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const s0 = dataSlice(keccak256(toUtf8Bytes('getSlot0(bytes32)')), 0, 4);
const liq = dataSlice(keccak256(toUtf8Bytes('getLiquidity(bytes32)')), 0, 4);

const latest = await p.getBlockNumber();
console.log('Latest block:', latest);

// Get recent swap events
const fromBlock = '0x' + (latest - 8).toString(16);
const filter = { address: PM, fromBlock, toBlock: 'latest', topics: [swapTopic] };
const logs = await p.getLogs(filter);
console.log(`Total swaps (last 100 blocks): ${logs.length}`);

// For each unique pool, check if RH6900 is involved
const uniquePools = new Set();
for (const log of logs) uniquePools.add(log.topics[1]);
console.log(`Unique pools: ${uniquePools.size}`);

// Check first 5 pools for RH6900 involvement
let poolChecked = 0;
for (const pid of uniquePools) {
  if (poolChecked >= 5) break;
  poolChecked++;
  
  // Check slot0 + liquidity for this pool  
  try {
    const r0 = await p.call({ to: SV, data: s0 + c.encode(['bytes32'], [pid]).slice(2) });
    const [sqrtP, tick] = c.decode(['uint160', 'int24', 'uint24', 'uint24'], r0);
    const r1 = await p.call({ to: SV, data: liq + c.encode(['bytes32'], [pid]).slice(2) });
    const [l] = c.decode(['uint128'], r1);
    console.log(`\nPool ${pid.slice(0,20)}... liq=${l} tick=${tick} sqrt=${sqrtP}`);
  } catch { console.log(`\nPool ${pid.slice(0,20)}... ERROR`); }
}

// Also directly check known RH6900 pools
console.log('\n\n=== RH6900 KNOWN POOLS ===');
const knownPids = [
  '0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362',
  '0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326',
];
for (const pid of knownPids) {
  try {
    const r0 = await p.call({ to: SV, data: s0 + c.encode(['bytes32'], [pid]).slice(2) });
    const [sqrtP, tick] = c.decode(['uint160', 'int24', 'uint24', 'uint24'], r0);
    const r1 = await p.call({ to: SV, data: liq + c.encode(['bytes32'], [pid]).slice(2) });
    const [l] = c.decode(['uint128'], r1);
    console.log(`\n${pid.slice(0,20)}... liq=${l} tick=${tick}`);
    
    // Decode pool key from events (check Initialize event)
    const initTopic = id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
    const flt = { address: PM, fromBlock: '0x0', toBlock: 'latest', topics: [initTopic, pid] };
    try {
      const initLogs = await p.getLogs(flt);
      if (initLogs.length > 0 && initLogs[0].data) {
        const [c0, c1, fee, ts, hooks] = c.decode(['address', 'address', 'uint24', 'int24', 'address'], initLogs[0].data);
        console.log(`  currency0=${c0} currency1=${c1} fee=${fee} ts=${ts} hooks=${hooks}`);
      }
    } catch { /* can't query */ }
  } catch {
    console.log(`\n${pid.slice(0,20)}... ERROR`);
  }
}

process.exit(0);
