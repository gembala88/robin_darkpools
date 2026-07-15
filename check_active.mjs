import { JsonRpcProvider, id } from 'ethers';

const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const swapTopic = id('Swap(bytes32,address,int256,int256,uint160,uint128,int24)');

const latest = await p.getBlockNumber();
console.log('Latest block:', latest);

// Check last 8 blocks for any V4 swap events
const filter = { address: PM, fromBlock: '0x' + (latest - 8).toString(16), toBlock: 'latest', topics: [swapTopic] };
const logs = await p.getLogs(filter);
console.log('Total V4 swaps (last 8 blocks):', logs.length);

const pools = new Set();
for (const log of logs) pools.add(log.topics[1]);
console.log('Active pools:', pools.size);
for (const pid of pools) {
  // Decode amount0 from the event data (first 32 bytes)
  const amt0 = BigInt('0x' + log.data.slice(2, 66));
  console.log(' ', pid, 'amt0:', amt0.toString());
}

// Also check if RH6900 has any swaps at all
if (logs.length === 0) {
  console.log('\nNo V4 swaps in last 8 blocks — V4 pool is INACTIVE');
  console.log('Checking if RH6900 pools exist with non-zero liquidity...');
}

process.exit(0);
