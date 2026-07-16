import { makeProvider } from './provider.js';
import { Contract, id as topicId } from 'ethers';

const V4_NFPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'.toLowerCase();
const V3_NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3'.toLowerCase();
const V4_POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'.toLowerCase();

const provider = await makeProvider('SCREENER_RPC_URL');
const head = await provider.getBlockNumber();
console.log(`Head: ${head}`);

// Test V3 NFPM positions() works
console.log('\n=== V3 NFPM positions(1) ===');
const v3nfpm = new Contract(V3_NFPM, [
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function ownerOf(uint256) view returns (address)',
], provider);
try {
  const [owner, pos] = await Promise.all([v3nfpm.ownerOf(1), v3nfpm.positions(1)]);
  console.log(`ownerOf(1): ${owner}`);
  console.log(`positions(1)[7] liquidity: ${pos[7]}`);
  console.log(`V3 ABI verified OK`);
} catch (e) {
  console.log(`V3 FAIL: ${e.shortMessage || e.message}`);
}

// Test V4 NFPM
console.log('\n=== V4 NFPM checks ===');
const v4nfpm = new Contract(V4_NFPM, [
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
], provider);

// ownerOf
try {
  const owner = await v4nfpm.ownerOf(1);
  console.log(`ownerOf(1): ${owner}`);
} catch (e) {
  console.log(`ownerOf(1): ${e.shortMessage || e.message}`);
}

// Try positions with several tokenIds
for (const tid of [1, 100, 1000, 50000]) {
  try {
    const pos = await v4nfpm.positions(tid);
    console.log(`positions(${tid})[7] liq: ${pos[7]}, token0: ${pos[2]?.slice(0,10)}...`);
  } catch (e) {
    console.log(`positions(${tid}): ${e.shortMessage || e.message}`);
  }
}

// tokenURI
try {
  const uri = await v4nfpm.tokenURI(1);
  console.log(`tokenURI(1): ${uri.slice(0, 80)}`);
} catch (e) {
  console.log(`tokenURI(1): ${e.shortMessage || e.message}`);
}

// Check if contract has code
const code = await provider.send('eth_getCode', [V4_NFPM, 'latest']);
console.log(`\nV4 NFPM code: ${code === '0x' ? 'NO CODE' : `${code.length} hex chars`}`);

// Check V4 NFPM totalSupply (if ERC721Enumerable)
try {
  const totalSupply = await provider.send('eth_call', [{
    to: V4_NFPM,
    data: '0x18160ddd'  // totalSupply()
  }, 'latest']);
  console.log(`totalSupply: ${BigInt(totalSupply)}`);
} catch (e) {
  console.log(`totalSupply: ${e.shortMessage || e.message}`);
}

// Check V4 NFPM symbol
try {
  const symHex = await provider.send('eth_call', [{
    to: V4_NFPM,
    data: '0x95d89b41'  // symbol()
  }, 'latest']);
  // Decode string
  const len = parseInt(symHex.slice(64, 128), 16);
  const sym = Buffer.from(symHex.slice(128, 128 + len*2), 'hex').toString();
  console.log(`symbol: ${sym}`);
} catch (e) {
  console.log(`symbol: ${e.shortMessage || e.message}`);
}

// Try alternative position function selectors
const selectors = [
  { sel: '0x514ea4bf', name: 'positions(uint256)' },
  { sel: '0x1f4f7f4a', name: 'getPosition(uint256)' },
  { sel: '0x0ea6e2a8', name: 'positionInfo(uint256)' },
  { sel: '0x2d34ba9b', name: 'getPositions(uint256)' },
];
for (const { sel, name } of selectors) {
  try {
    const result = await provider.send('eth_call', [{
      to: V4_NFPM,
      data: sel + '0000000000000000000000000000000000000000000000000000000000000001',
    }, 'latest']);
    const status = result === '0x' ? 'empty (not found)' : `${result.length} hex chars`;
    console.log(`${name} (${sel}): ${status}`);
  } catch (e) {
    console.log(`${name} (${sel}): REVERTED — ${e.shortMessage?.slice(0, 60)}`);
  }
}

// Check V4 NFPM positions via MODIFY_LIQUIDITY events approach
// Get a recent ModifyLiquidity
const MODIFY_LIQ_SIG = topicId('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const poolId = '0x60ed58bf612bd78d60edc7f352ab71126821fdb8909399efb0ce0aa2b9c0d3a9';
const filter = {
  address: V4_POOLMANAGER,
  topics: [MODIFY_LIQ_SIG, poolId],
  fromBlock: '0x' + Math.max(0, head - 5000).toString(16),
  toBlock: '0x' + head.toString(16),
};
const logs = await provider.send('eth_getLogs', [filter]);
console.log(`\nModifyLiquidity events (last 5K blocks): ${logs.length}`);
if (logs.length > 0) {
  const txHash = logs[logs.length - 1].transactionHash;
  const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
  const nfpmLogs = (receipt?.logs || []).filter(l => l.address.toLowerCase() === V4_NFPM);
  console.log(`NFPM logs in latest tx: ${nfpmLogs.length}`);
  if (nfpmLogs.length > 0) {
    const tid = BigInt(nfpmLogs[0].topics[3]).toString();
    console.log(`Found tokenId: ${tid}`);
    // Try positions with raw direct eth_call
    try {
      const rawPos = await provider.send('eth_call', [{
        to: V4_NFPM,
        data: '0x514ea4bf' + BigInt(tid).toString(16).padStart(64, '0'),
      }, 'latest']);
      console.log(`positions(${tid}) raw result: ${rawPos.slice(0, 100)}...`);
    } catch (e) {
      console.log(`positions(${tid}) raw: ${e.shortMessage?.slice(0, 60)}`);
    }
  }
}

console.log('\n=== Done ===');
