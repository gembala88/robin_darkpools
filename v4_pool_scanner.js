import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { makeProvider } from './provider.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

// event Initialize(
//   PoolId indexed id,         // bytes32
//   Currency indexed currency0, // address
//   Currency indexed currency1, // address
//   uint24 fee,
//   int24 tickSpacing,
//   IHooks hooks,
//   uint160 sqrtPriceX96,
//   int24 tick
// );
const INIT_SIG = 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)';
const INIT_TOPIC0 = ethers.id(INIT_SIG);

const REGISTRY_PATH = new URL('./v4_pool_registry.json', import.meta.url);
const CHUNK_SIZE = 100_000;
const TIMEOUT_MS = 20_000;

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch {
    return { pools: {}, lastScannedBlock: 0, lastScannedAt: null };
  }
}

function saveRegistry(reg) {
  reg.lastScannedAt = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function toPoolKey(entry) {
  return { currency0: entry.currency0, currency1: entry.currency1, fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks };
}

function getPoolId(entry) {
  return entry.poolId;
}

export async function scanV4Pools(provider) {
  if (!provider) provider = await makeProvider('LP_SCREENER_RPC_URL');

  const reg = loadRegistry();
  const head = await provider.getBlockNumber();
  const fromBlock = reg.lastScannedBlock > 0 ? reg.lastScannedBlock + 1 : 0;

  if (fromBlock > head) {
    return { scanned: 0, total: Object.keys(reg.pools).length, head, registry: reg };
  }

  console.log(`[v4_scanner] scanning Initialize events ${fromBlock} → ${head} (${(head - fromBlock + 1).toLocaleString()} blocks)`);

  let newPools = 0;
  let scanned = 0;

  for (let start = fromBlock; start <= head; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, head);
    let logs;
    try {
      logs = await Promise.race([
        provider.getLogs({ address: POOL_MANAGER, topics: [INIT_TOPIC0], fromBlock: start, toBlock: end }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
      ]);
    } catch (e) {
      if (e.message === 'timeout') {
        console.warn(`  [v4_scanner] TIMEOUT ${start}-${end}, skipping chunk`);
        continue;
      }
      const msg = e.shortMessage || e.message;
      if (msg.includes('query returned more than 10000')) {
        // Sub-chunk and retry
        const subSize = Math.floor(CHUNK_SIZE / 4);
        for (let ss = start; ss <= end; ss += subSize) {
          const se = Math.min(ss + subSize - 1, end);
          try {
            const sl = await Promise.race([
              provider.getLogs({ address: POOL_MANAGER, topics: [INIT_TOPIC0], fromBlock: ss, toBlock: se }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
            ]);
            for (const l of sl) {
              const poolId = l.topics[1].toLowerCase();
              if (!reg.pools[poolId]) {
                reg.pools[poolId] = parseInitLog(l);
                newPools++;
              }
            }
          } catch {}
        }
        continue;
      }
      console.warn(`  [v4_scanner] error ${start}-${end}: ${msg.slice(0, 120)}`);
      continue;
    }

    for (const l of logs) {
      const poolId = l.topics[1].toLowerCase();
      if (!reg.pools[poolId]) {
        reg.pools[poolId] = parseInitLog(l);
        newPools++;
      }
    }
    scanned += logs.length;
  }

  reg.lastScannedBlock = head;
  saveRegistry(reg);

  console.log(`[v4_scanner] done: ${newPools} new, ${Object.keys(reg.pools).length} total V4 pools in registry`);
  return { scanned: newPools, total: Object.keys(reg.pools).length, head, registry: reg };
}

function parseInitLog(l) {
  const poolId = l.topics[1].toLowerCase();
  const currency0 = '0x' + l.topics[2].slice(26).toLowerCase();
  const currency1 = '0x' + l.topics[3].slice(26).toLowerCase();
  const abi = new ethers.AbiCoder();
  const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
  return {
    poolId,
    currency0,
    currency1,
    fee: Number(d[0]),
    tickSpacing: Number(d[1]),
    hooks: d[2].toLowerCase(),
    sqrtPriceX96: d[3].toString(),
    tick: Number(d[4]),
    initializedAt: l.blockNumber,
    discoveredAt: Date.now(),
  };
}

// Look up poolId in registry — returns full pool key or null
export function lookupV4Pool(poolId) {
  const reg = loadRegistry();
  const entry = reg.pools[poolId.toLowerCase()];
  if (!entry) return null;
  return { ...entry, partial: false };
}

// Expose for enrichPoolData integration
export function getV4Registry() {
  return loadRegistry();
}

// CLI: standalone scan (isMain guard — only runs when executed directly)
const isMain = process.argv[1] && (
  process.argv[1] === import.meta.url ||
  process.argv[1].endsWith('v4_pool_scanner.js') ||
  process.argv[1].endsWith('v4_pool_scanner')
);

async function main() {
  console.log('V4 Pool Scanner — incremental Initialize event scan\n');
  const result = await scanV4Pools();
  console.log(`\nRegistry: ${result.total} pools, last block: ${result.head}`);

  // Count unique fee tiers
  const fees = {};
  for (const p of Object.values(result.registry.pools)) {
    const f = p.fee;
    fees[f] = (fees[f] || 0) + 1;
  }
  console.log('Fee tiers:', Object.entries(fees).sort((a, b) => a[0] - b[0]).map(([f, c]) => `${(Number(f)/10000).toFixed(4)}% x${c}`).join(', '));

  // Check CASHCAT V4
  const cashcatPoolId = '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b';
  const cashcat = result.registry.pools[cashcatPoolId];
  if (cashcat) {
    console.log(`\nCASHCAT V4: fee=${cashcat.fee} (${(cashcat.fee/10000).toFixed(4)}%) tickSpacing=${cashcat.tickSpacing} hooks=${cashcat.hooks}`);
  }
}

if (isMain) main().catch(e => { console.error(e); process.exit(1); });
