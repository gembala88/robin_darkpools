// Test V4 HHI for multiple V4 pools — replicates _computeV4HHIImpl logic
import { makeProvider } from './provider.js';
import { Contract, id as topicId } from 'ethers';

const V4_NFPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'.toLowerCase();
const V4_POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'.toLowerCase();
const MODIFY_LIQ_SIG = topicId('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const TRANSFER_SIG = topicId('Transfer(address,address,uint256)');

// V4 poolIds from DexScreener — test key pools
const poolIds = [
  { id: '0x60ed58bf612bd78d60edc7f352ab71126821fdb8909399efb0ce0aa2b9c0d3a9', name: 'CLAUDEX ($94K TVL)' },
  { id: '0x1299aa8c4ea0db5b8453757ed129ed8e916561925926a161cb89842e3987401a', name: 'AGENTOS ($140K TVL)' },
  { id: '0x36f0a3bb1a9491bbd777bc250797471b5a9c919502c4066614ff4920889a99cb', name: 'AGENTOS ($4.7K TVL)' },
];

let _provider = null;
async function getProvider() {
  if (!_provider) _provider = await makeProvider('SCREENER_RPC_URL');
  return _provider;
}

async function computeV4HHIImpl(poolId) {
  const provider = await getProvider();
  const head = await provider.getBlockNumber();
  const step = 500_000;
  const v4nfpm = new Contract(V4_NFPM, [
    'function getPositionLiquidity(uint256) view returns (uint128)',
    'function ownerOf(uint256) view returns (address)',
  ], provider);

  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    console.log(`  Invalid bytes32: ${poolId}`);
    return;
  }

  // Collect ModifyLiquidity events
  const allMods = [];
  let fetchErrors = 0;
  const totalChunks = Math.ceil((head + 1) / step);
  for (let s = 0; s <= head; s += step) {
    try {
      const rawFilter = {
        address: V4_POOLMANAGER,
        topics: [MODIFY_LIQ_SIG, poolId],
        fromBlock: '0x' + s.toString(16),
        toBlock: '0x' + Math.min(s + step - 1, head).toString(16),
      };
      const logs = await provider.send('eth_getLogs', [rawFilter]);
      allMods.push(...logs);
    } catch (e) {
      fetchErrors++;
    }
  }

  console.log(`  Chunks: ${totalChunks} (errors: ${fetchErrors}), ModifyLiquidity events: ${allMods.length}`);

  if (allMods.length === 0) return;

  // Extract unique tokenIds from positive-amount modifications
  const tokenIds = new Set();
  for (const lg of allMods) {
    const amountHex = '0x' + lg.data.slice(130, 194);
    const amt = BigInt(amountHex);
    const MAX_INT255 = 1n << 255n;
    const amount = amt >= MAX_INT255 ? amt - (1n << 256n) : amt;
    if (amount <= 0n) continue;

    const receipt = await provider.send('eth_getTransactionReceipt', [lg.transactionHash]);
    if (!receipt) continue;
    for (const rlog of receipt.logs) {
      if (rlog.address.toLowerCase() !== V4_NFPM) continue;
      if (rlog.topics[0] !== TRANSFER_SIG) continue;
      if (rlog.topics[3]) tokenIds.add(BigInt(rlog.topics[3]).toString());
    }
  }

  console.log(`  TokenIds from positive amounts: ${tokenIds.size}`);

  if (tokenIds.size < 2) return;

  const ownerLiq = {};
  const ids = [...tokenIds].map(s => BigInt(s));
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(async tid => {
        try {
          const [liq, owner] = await Promise.all([v4nfpm.getPositionLiquidity(tid), v4nfpm.ownerOf(tid)]);
          if (liq > 0n) return { owner: owner.toLowerCase(), liquidity: liq };
        } catch (e) {}
        return null;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        ownerLiq[r.value.owner] = (ownerLiq[r.value.owner] || 0n) + r.value.liquidity;
      }
    }
  }

  const pc = Object.keys(ownerLiq).length;
  const tl = Object.values(ownerLiq).reduce((s, v) => s + v, 0n);
  if (pc < 2 || tl === 0n) {
    console.log(`  Only ${pc} providers with active positions`);
    return;
  }

  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / tl) / 100;
    return s + share * share;
  }, 0);

  let penalty = 0;
  if (hhi > 2500) penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);

  console.log(`  RESULT: HHI=${Math.round(hhi)} providers=${pc} penalty=${penalty}`);
}

console.log('=== V4 HHI Full Test ===\n');
let idx = 0;
for (const { id, name } of poolIds) {
  idx++;
  console.log(`[${idx}/${poolIds.length}] ${name} — ${id.slice(0, 18)}...`);
  try {
    await Promise.race([
      computeV4HHIImpl(id),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 300000))
    ]);
  } catch (e) {
    console.log(`  FAIL: ${e.shortMessage || e.message}`);
  }
  console.log('');
}
console.log('=== Done ===');
