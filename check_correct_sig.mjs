import { JsonRpcProvider, id } from 'ethers';
const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

// CORRECT event signature from PoolManager ABI
const swapTopic = id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const initTopic = id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const liqTopic = id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');

const latest = await p.getBlockNumber();
console.log('Latest block:', latest);

// Check last 8 blocks for CORRECT swap events
const f1 = { address: PM, fromBlock: '0x'+(latest-8).toString(16), toBlock: 'latest', topics: [swapTopic] };
try {
  const logs = await p.getLogs(f1);
  console.log(`\nV4 Swap events (last 8 blocks, CORRECT sig): ${logs.length}`);
  if (logs.length > 0) {
    for (const log of logs) {
      console.log(`  block=${log.blockNumber} poolId=${log.topics[1].slice(0, 42)}`);
    }
  }
} catch(e) { console.log('Swap error:', e.shortMessage); }

// Check Initialize events
const f2 = { address: PM, fromBlock: '0x'+(latest-8).toString(16), toBlock: 'latest', topics: [initTopic] };
try {
  const logs = await p.getLogs(f2);
  console.log(`\nInitialize events (last 8 blocks): ${logs.length}`);
} catch(e) { console.log('Init error:', e.shortMessage); }

// Check ModifyLiquidity events
const f3 = { address: PM, fromBlock: '0x'+(latest-8).toString(16), toBlock: 'latest', topics: [liqTopic] };
try {
  const logs = await p.getLogs(f3);
  console.log(`\nModifyLiquidity events (last 8 blocks): ${logs.length}`);
} catch(e) { console.log('Liq error:', e.shortMessage); }

// Now specifically check RH6900 pools
const pids = [
  '0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362',
  '0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326',
];
for (const pid of pids) {
  const ff = { address: PM, fromBlock: '0x'+(latest-500).toString(16), toBlock: 'latest', topics: [swapTopic, pid] };
  try {
    const logs = await p.getLogs(ff);
    if (logs.length > 0) {
      console.log(`\nRH6900 ${pid.slice(0,20)} swap events (last 500 blocks): ${logs.length}`);
      const lastLog = logs[logs.length-1];
      console.log(`  Latest at block ${lastLog.blockNumber}`);
    }
  } catch(e) { /* skip */ }
}

process.exit(0);
