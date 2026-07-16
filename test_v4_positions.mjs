import { makeProvider } from './provider.js';
import { Contract, id as topicId } from 'ethers';

const V4_NFPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'.toLowerCase();
const V4_POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'.toLowerCase();
const MODIFY_LIQ_SIG = topicId('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');

const provider = await makeProvider('SCREENER_RPC_URL');

// Test 1: Check ownerOf(1) works
console.log('=== Test 1: ownerOf(1) ===');
const nfpm = new Contract(V4_NFPM, [
  'function ownerOf(uint256) view returns (address)',
], provider);
try {
  const owner = await nfpm.ownerOf(1);
  console.log(`ownerOf(1) = ${owner}`);
} catch (e) {
  console.log(`ownerOf(1) FAIL: ${e.shortMessage || e.message}`);
}

// Test 2: Check positions(1) full returns
console.log('\n=== Test 2: positions(1) full return ===');
const nfpm2 = new Contract(V4_NFPM, [
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
], provider);
try {
  const pos = await nfpm2.positions(1);
  console.log(`positions(1) full:`);
  console.log(`  [0] nonce: ${pos[0]}`);
  console.log(`  [1] operator: ${pos[1]}`);
  console.log(`  [2] token0: ${pos[2]}`);
  console.log(`  [3] token1: ${pos[3]}`);
  console.log(`  [4] fee: ${pos[4]}`);
  console.log(`  [5] tickLower: ${pos[5]}`);
  console.log(`  [6] tickUpper: ${pos[6]}`);
  console.log(`  [7] liquidity: ${pos[7]} (type: ${typeof pos[7]})`);
  console.log(`  [7] liquidity > 0: ${pos[7] > 0n}`);
  console.log(`  [8] tokensOwed0: ${pos[8]}`);
  console.log(`  [9] tokensOwed1: ${pos[9]}`);
  console.log(`  [10] feeGrowth0: ${pos[10]}`);
  console.log(`  [11] feeGrowth1: ${pos[11]}`);
} catch (e) {
  console.log(`positions(1) FAIL: ${e.shortMessage || e.message}`);
}

// Test 3: Check raw eth_call to positions(1)
console.log('\n=== Test 3: raw positions(1) ===');
// positions(uint256) selector: 0x514ea4bf
const data = '0x514ea4bf0000000000000000000000000000000000000000000000000000000000000001';
try {
  const raw = await provider.send('eth_call', [{ to: V4_NFPM, data }, 'latest']);
  console.log(`raw response: ${raw}`);
  // Decode manually: first 32 bytes = uint96 (padded), next 32 = address, etc.
  console.log(`  length: ${raw.length} hex chars`);
} catch (e) {
  console.log(`raw call FAIL: ${e.shortMessage || e.message}`);
}

// Test 4: Get a real V4 tokenId from ModifyLiquidity events
console.log('\n=== Test 4: Find real V4 tokenId ===');
const poolId = '0x60ed58bf612bd78d60edc7f352ab71126821fdb8909399efb0ce0aa2b9c0d3a9';
const head = await provider.getBlockNumber();
const rawFilter = {
  address: V4_POOLMANAGER,
  topics: [MODIFY_LIQ_SIG, poolId],
  fromBlock: '0x' + Math.max(0, head - 100000).toString(16),
  toBlock: '0x' + head.toString(16),
};
const logs = await provider.send('eth_getLogs', [rawFilter]);
console.log(`ModifyLiquidity events: ${logs.length}`);
if (logs.length > 0) {
  const lg = logs[0];
  console.log(`First event tx: ${lg.transactionHash}`);
  console.log(`data[0..64]: ${lg.data.slice(0, 66)}`);
  console.log(`data[64..128]: ${lg.data.slice(64, 130)}`);
  console.log(`data[128..192] (liquidityDelta): ${lg.data.slice(128, 194)}`);
  
  // Get receipt and find Transfer tokenId
  const receipt = await provider.send('eth_getTransactionReceipt', [lg.transactionHash]);
  if (receipt) {
    for (const rlog of receipt.logs) {
      if (rlog.address.toLowerCase() === V4_NFPM && rlog.topics[0] === topicId('Transfer(address,address,uint256)')) {
        console.log(`NFPM Transfer in receipt: from=${rlog.topics[1]} to=${rlog.topics[2]} tokenId=${rlog.topics[3]}`);
        const tid = BigInt(rlog.topics[3]).toString();
        console.log(`  Parsed tokenId: ${tid}`);
        
        // Check positions for this tokenId
        try {
          const pos = await nfpm2.positions(tid);
          console.log(`  positions(${tid})[7] liquidity: ${pos[7]}`);
          console.log(`  positions(${tid}) token0: ${pos[2]} token1: ${pos[3]} fee: ${pos[4]}`);
        } catch (e) {
          console.log(`  positions(${tid}) FAIL: ${e.shortMessage || e.message}`);
        }
        break;
      }
    }
  }
}

console.log('\n=== Done ===');
