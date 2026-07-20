import 'dotenv/config';
import fs from 'node:fs';
import { Contract, id as topicId, getAddress, AbiCoder } from 'ethers';
import { UC } from './config.js';
import { tgScreener } from './telegram.js';
import { checkGMGN } from './gmgn.js';
import { makeProvider } from './provider.js';
import { autoOpenExecute, checkAutoOpenConditions, enrichPoolData, recordTrendSnapshot } from './lp_auto_open.js';
import { scanV4Pools } from './v4_pool_scanner.js';

const DEXSCREENER_PROFILES = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEXSCREENER_BOOSTS = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEXSCREENER_TOKEN_PAIRS = 'https://api.dexscreener.com/token-pairs/v1/';

// ===== DEXSCREENER API =====
const DS_BASE = 'https://api.dexscreener.com/latest/dex';

// ===== ON-CHAIN ADDRESSES =====
const V3_FACTORY    = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const V4_POOLMANAGER= '0x8366a39cc670b4001a1121b8f6a443a643e40951';

// ===== EVENT SIGNATURES =====
const V3_POOL_CREATED = topicId('PoolCreated(address,address,uint24,int24,address)');
const V4_INITIALIZE   = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

// ===== USER-CONFIG ACCESS =====
function cfg(key) { return UC(key); }
function cfgLp(key) { return UC('lp.' + key); }
const ucSafe = (prefix) => (key) => { try { return UC(prefix + key); } catch { return undefined; } };
const cfgSc = ucSafe('lpScreener.');
const cfgDS = ucSafe('dexScreener.');

// ===== STATE =====
const STATE_FILE = 'lp_screener_state.json';
let state = { pools: {}, lastDiscovery: 0, lastFetch: 0 };
let startTime = Date.now();
let _lastTokenDiag = 0;

// ===== HELPERS =====
const coder = AbiCoder.defaultAbiCoder();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (a) => a.toLowerCase();

const DS_SEARCH_TERMS = cfgDS('searchTerms') || [
  'robinhood', 'ROBINHOOD', 'Robinhood', 'cashcat', 'CASHCAT',
  'HOOD', 'CLAUDEX', 'AGENTOS', 'CHAIN', 'CHAINHOOD', 'ROBINHOODCHAIN',
  'TSUKI', 'LOSS', 'MACRO', 'AGENT', 'MARION', 'IMF', 'SCRY', 'MAQU', 'RHAGENT', 'ELON',
  'freeop', 'pooch', 'oc', 'bread', 'santacoin', 'trashy', 'mystery',
];

// ===== SCORE WEIGHTS =====
const W = {
  volumeTvlRatio: 10,
  swaps24h:       20,
  tvlUsd:         25,
  ageDays:        10,
  priceChange:     5,
  gmgnClean:      10,
  momentum5m:     20,
};

// ===== DEXSCREENER FETCH =====
let lastDsCall = 0;
async function fetchDexScreener(path) {
  const now = Date.now();
  const gap = now - lastDsCall;
  if (gap < 500) await sleep(500 - gap); // max 2 calls/sec
  lastDsCall = Date.now();
  const url = `${DS_BASE}${path}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.status === 429) { console.log('DexScreener 429 — cooling down 10s'); await sleep(10000); return null; }
    return await r.json();
  } catch (e) { console.log(`DexScreener error: ${e.shortMessage || e.message}`); return null; }
}

async function fetchBatchPools(addrs) {
  if (!addrs.length) return [];
  // batch up to 30 per call
  const results = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const path = `/pairs/robinhood/${chunk.join(',')}`;
    const j = await fetchDexScreener(path);
    if (j?.pairs) results.push(...j.pairs);
  }
  return results;
}

// ===== DISCOVER POOLS (ON-CHAIN) =====

async function discoverV3Pools(provider, fromBlock, toBlock) {
  const out = [];
  if (fromBlock > toBlock) return out;
  const step = 500_000;
  for (let s = fromBlock; s <= toBlock; s += step) {
    const e = Math.min(s + step - 1, toBlock);
    try {
      const logs = await Promise.race([
        provider.getLogs({ address: V3_FACTORY, topics: [V3_POOL_CREATED], fromBlock: s, toBlock: e }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getLogs timeout 15s')), 15000))
      ]);
      for (const lg of logs) {
        const token0 = getAddress('0x' + lg.topics[1].slice(26));
        const token1 = getAddress('0x' + lg.topics[2].slice(26));
        const fee = Number(BigInt(lg.topics[3]));
        const [tickSpacing, pool] = coder.decode(['int24', 'address'], lg.data);
        out.push({ pool: lc(pool), token0: lc(token0), token1: lc(token1), fee, tickSpacing, version: 'v3', block: lg.blockNumber });
      }
    } catch (err) {
      console.log(`  V3 scan chunk ${s}-${e} error: ${err.shortMessage || err.message}`);
    }
  }
  return out;
}

async function discoverV4Pools(provider, fromBlock, toBlock) {
  const out = [];
  if (fromBlock > toBlock) return out;
  const step = 500_000;
  for (let s = fromBlock; s <= toBlock; s += step) {
    const e = Math.min(s + step - 1, toBlock);
    try {
      const logs = await Promise.race([
        provider.getLogs({ address: V4_POOLMANAGER, topics: [V4_INITIALIZE], fromBlock: s, toBlock: e }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getLogs timeout 15s')), 15000))
      ]);
      for (const lg of logs) {
        const currency0 = getAddress('0x' + lg.topics[2].slice(26));
        const currency1 = getAddress('0x' + lg.topics[3].slice(26));
        const [fee, tickSpacing, hooks] = coder.decode(['uint24', 'int24', 'address'], lg.data);
        const poolId = lg.topics[1];
        out.push({ pool: lc(poolId), poolId, currency0: lc(currency0), currency1: lc(currency1), fee, tickSpacing, hooks: lc(hooks), version: 'v4', block: lg.blockNumber });
      }
    } catch (err) {
      console.log(`  V4 scan chunk ${s}-${e} error: ${err.shortMessage || err.message}`);
    }
  }
  return out;
}

// ===== ON-CHAIN LIQUIDITY FILTER (pre-filter sebelum DexScreener) =====
const LIQUIDITY_SELECTOR = '0x1a686502'; // keccak256("liquidity()")[0:4]

async function filterLiquidPools(provider, pools, label) {
  if (!pools.length) return { liquid: [], failed: [] };
  const CONCURRENCY = 30;
  const liquid = [];
  const failedPools = [];
  let dry = 0;

  for (let i = 0; i < pools.length; i += CONCURRENCY) {
    const chunk = pools.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(p => Promise.race([
        provider.call({ to: p.pool, data: LIQUIDITY_SELECTOR }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('liquidity() timeout 8s')), 8000))
      ]))
    );

    for (let j = 0; j < chunk.length; j++) {
      if (results[j].status === 'fulfilled') {
        const liq = BigInt(results[j].value);
        if (liq > 0n) {
          liquid.push(chunk[j]);
        } else {
          dry++;
        }
      } else {
        failedPools.push(chunk[j]);
      }
    }

    const done = Math.min(i + CONCURRENCY, pools.length);
    if (done % 300 === 0 || done === pools.length) {
      console.log(`  ${label}: ${done}/${pools.length} checked — ${liquid.length} liquid, ${dry} dry${failedPools.length ? `, ${failedPools.length} failed` : ''}`);
    }
  }

  if (failedPools.length) console.log(`  ${label}: done — ${liquid.length} liquid, ${dry} dry, ${failedPools.length} failed (saved for retry)`);
  else console.log(`  ${label}: done — ${liquid.length} liquid, ${dry} dry`);
  return { liquid, failed: failedPools };
}

// ===== TOKEN DISCOVERY (profiles + boosts → token-pairs → search) =====
async function discoverFromTokenEndpoint(url, label) {
  let count = 0;
  try {
    const data = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
    if (!Array.isArray(data)) return 0;
    const rh = data.filter(x => x.chainId === 'robinhood');
    for (const entry of rh) {
      const addr = entry.tokenAddress;
      // Try to find pairs for this token
      try {
        const pairs = await (await fetch(DEXSCREENER_TOKEN_PAIRS + 'robinhood/' + addr, { signal: AbortSignal.timeout(5000) })).json();
        if (Array.isArray(pairs)) {
          for (const p of pairs) {
            const key = lc(p.pairAddress);
            if (!state.pools[key]) {
              state.pools[key] = poolFromDSPair(p);
              state.pools[key].discoveredAt = Date.now();
              count++;
            }
          }
        }
      } catch (e) {}
    }
    console.log(`  ${label}: ${rh.length} tokens, ${count} new pools`);
  } catch (e) {
    console.log(`  ${label}: error ${e.message?.slice(0, 50)}`);
  }
  return count;
}

// ===== INITIAL DISCOVERY (DexScreener search + profiles + boosts) =====
async function runInitialDiscovery() {
  console.log('\n=== Initial LP Pool Discovery ===');

  // 1. Seed from DexScreener keyword search
  console.log('Searching DexScreener for pools by keyword...');
  for (const term of DS_SEARCH_TERMS) {
    const j = await fetchDexScreener(`/search?q=${encodeURIComponent(term)}`);
    if (!j?.pairs) continue;
    let rhCount = 0;
    for (const p of j.pairs) {
      if (p.chainId !== 'robinhood') continue;
      const addr = lc(p.pairAddress);
      if (!state.pools[addr]) {
        state.pools[addr] = poolFromDSPair(p);
        state.pools[addr].discoveredAt = Date.now();
      }
      rhCount++;
    }
    if (rhCount) console.log(`  keyword "${term}": ${rhCount} rh pools`);
  }

  // 2. Token profiles → token-pairs
  await discoverFromTokenEndpoint(DEXSCREENER_PROFILES, 'profiles');

  // 3. Token boosts → token-pairs
  await discoverFromTokenEndpoint(DEXSCREENER_BOOSTS, 'boosts');

  saveState();
  console.log(`Total pools tracked: ${Object.keys(state.pools).length}`);
}

// ===== POOL STATE FACTORY =====
function poolFromDSPair(p) {
  const txns = p.txns?.h24 || { buys: 0, sells: 0 };
  return {
    pairAddress: lc(p.pairAddress),
    baseToken: { address: lc(p.baseToken.address), name: p.baseToken.name, symbol: p.baseToken.symbol },
    quoteToken: { address: lc(p.quoteToken?.address || ''), name: p.quoteToken?.name || '', symbol: p.quoteToken?.symbol || '' },
    version: (p.labels || []).find(l => l.startsWith('v')) || '?',
    labels: p.labels || [],
    dex: p.dexId,
    pairCreatedAt: p.pairCreatedAt,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : 0,
    priceNative: p.priceNative || '0',
    tvlUsd: p.liquidity?.usd || 0,
    volume24h: p.volume?.h24 || 0,
    swaps24h: (txns.buys || 0) + (txns.sells || 0),
    buys24h: txns.buys || 0,
    sells24h: txns.sells || 0,
    m5vol: p.volume?.m5 || 0,
    m5buys: p.txns?.m5?.buys || 0,
    m5sells: p.txns?.m5?.sells || 0,
    priceChange24h: p.priceChange?.h24 ?? null,
    fdv: p.fdv || 0,
    marketCap: p.marketCap || 0,
    socials: p.info?.socials || [],
    websites: p.info?.websites || [],
    gmgnFlags: null,
    gmgnChecked: false,
    score: 0,
    scoreBreakdown: {},
    notified: false,
    discoveredAt: Date.now(),
    lastUpdated: Date.now(),
  };
}

// ===== DEXSCREENER DATA UPDATE =====
async function updatePoolData() {
  const addrs = Object.keys(state.pools);
  if (!addrs.length) return 0;
  const pairs = await fetchBatchPools(addrs);
  let updated = 0;
  for (const p of pairs) {
    const key = lc(p.pairAddress);
    if (!state.pools[key]) {
      state.pools[key] = poolFromDSPair(p);
    } else {
      const po = state.pools[key];
      const txns = p.txns?.h24 || { buys: 0, sells: 0 };
      po.priceUsd = p.priceUsd ? Number(p.priceUsd) : 0;
      po.priceNative = p.priceNative || '0';
      po.tvlUsd = p.liquidity?.usd || 0;
      po.volume24h = p.volume?.h24 || 0;
      po.swaps24h = (txns.buys || 0) + (txns.sells || 0);
      po.buys24h = txns.buys || 0;
      po.sells24h = txns.sells || 0;
        po.priceChange24h = p.priceChange?.h24 ?? null;
        po.m5vol = p.volume?.m5 || 0;
        po.m5buys = p.txns?.m5?.buys || 0;
        po.m5sells = p.txns?.m5?.sells || 0;
      po.fdv = p.fdv || 0;
      po.marketCap = p.marketCap || 0;
      po.lastUpdated = Date.now();
      if (!po.baseToken?.symbol) {
        po.baseToken = { address: lc(p.baseToken.address), name: p.baseToken.name, symbol: p.baseToken.symbol };
      }
      if (!po.quoteToken?.symbol) {
        po.quoteToken = { address: lc(p.quoteToken?.address || ''), name: p.quoteToken?.name || '', symbol: p.quoteToken?.symbol || '' };
      }
      if (!po.labels?.length && p.labels?.length) po.labels = p.labels;
    }
    updated++;
  }
  return updated;
}

// ===== ON-CHAIN DISCOVERY (DISABLED — using DexScreener only) =====
async function runPeriodicDiscovery() {
  return 0;
}

// ===== SCORING =====
function computeScore(po) {
  const tvl = po.tvlUsd || 0;
  const vol = po.volume24h || 0;
  const swaps = po.swaps24h || 0;
  const ageDays = po.pairCreatedAt ? (Date.now() - po.pairCreatedAt) / 86400000 : 0;
  const m5swaps = (po.m5buys || 0) + (po.m5sells || 0);

  // TVL score (log scale: $1k=0, $10k=20, $100k=40, $1M=60, $10M=80, $100M=100)
  const tvlScore = Math.min(Math.max(0, Math.log10(Math.max(tvl, 1000) / 1000) * 20), 100) * (W.tvlUsd / 100);

  // Volume/TVL ratio with log scale (diminishes extreme ratio advantage) + minimum TVL guard
  const tvlGuard = Math.min(tvl / 50000, 1);
  const volTvlRatio = tvl > 0 ? vol / tvl : 0;
  const volRaw = Math.min(Math.log10(Math.max(volTvlRatio, 0.1) + 1) * 50, 100);
  const volTvlScore = volRaw * tvlGuard * (W.volumeTvlRatio / 100);

  // Swap count (24h)
  const swapScore = Math.min(swaps / 1000, 100) * (W.swaps24h / 100);

  // Age score (prefer newer pools)
  const ageScore = Math.max(0, Math.min((30 - ageDays) / 30 * 100, 100)) * (W.ageDays / 100);

  // Price change stability
  let pcScore = 50;
  const pc = po.priceChange24h;
  if (pc !== null && pc !== undefined) {
    if (Math.abs(pc) < 50) pcScore = 80;
    else if (Math.abs(pc) < 200) pcScore = 50;
    else pcScore = 20;
  }
  const priceScore = pcScore * (W.priceChange / 100);

  // GMGN
  const gmgnScore = (po.gmgnChecked && !po.gmgnFlags?.length) ? (W.gmgnClean / 100) * 100 : 0;

  // Momentum 5min (active right now)
  let m5Score = 0;
  if (m5swaps > 0) {
    const m5vol = po.m5vol || 0;
    m5Score = Math.min(Math.log10(m5swaps + 1) * 33, 100) * (W.momentum5m / 100);
  }

  const total = volTvlScore + swapScore + tvlScore + ageScore + priceScore + gmgnScore + m5Score;

  return {
    score: Math.round(total),
    breakdown: {
      tvl: Math.round(tvlScore),
      volTvlRatio: Math.round(volTvlScore),
      swaps: Math.round(swapScore),
      age: Math.round(ageScore),
      price: Math.round(priceScore),
      gmgn: Math.round(gmgnScore),
      momentum5m: Math.round(m5Score),
    },
    volTvlRatio,
  };
}

// ===== HHI / LP CONCENTRATION PENALTY =====
const V3_NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3';
const POOL_MINT_SIG = topicId('Mint(address,address,int24,int24,uint128,uint256,uint256)');
const INC_LIQ_SIG = topicId('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const TRANSFER_SIG = topicId('Transfer(address,address,uint256)');

let _hhiProvider = null;
function getHHIProvider() {
  if (!_hhiProvider) {
    const envKey = process.env.LP_SCREENER_RPC_URL ? 'LP_SCREENER_RPC_URL' : 'LP_RPC_URL';
    _hhiProvider = makeProvider(envKey);
  }
  return _hhiProvider;
}

/**
 * Compute HHI penalty for a given pool address.
 * Samples the first N unique Pool Mint txs, finds NFPM tokenIds and their owners,
 * then computes HHI. Caches result in poolState.hhiScore / hhiData.
 * Returns penalty points (0 to -50).
 * Wrapped in a 180s timeout to prevent hanging on RPC issues.
 */
async function computeHHIPenalty(poolAddr, poolState) {
  if (poolState.hhiChecked) return (poolState.hhiPenalty || 0);
  if (poolState.hhiChecking) return 0; // already being checked

  poolState.hhiChecking = true;

  const result = await Promise.race([
    _computeHHIImpl(poolAddr, poolState),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HHI top-level timeout (180s)')), 180000))
  ]).catch(err => {
    console.log(`  HHI error for ${poolAddr.slice(0, 14)}: ${err.shortMessage || err.message}`);
    poolState.hhiChecking = false;
    poolState.hhiFailed = (poolState.hhiFailed || 0) + 1;
    poolState.hhiFailedAt = Date.now();
    return 0;
  });
  return result;
}

async function _computeHHIImpl(poolAddr, poolState) {
  const provider = await getHHIProvider();
  const head = await provider.getBlockNumber();
  const step = 500_000;
  const nfpm = new Contract(V3_NFPM, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
  ], provider);

  // Collect ALL unique tx hashes from Pool Mint events (need the MOST RECENT ones for active positions)
  const allMintTxs = [];
  for (let s = 0; s <= head; s += step) {
    const e = Math.min(s + step - 1, head);
    try {
      const logs = await Promise.race([
        provider.getLogs({ address: poolAddr, topics: [POOL_MINT_SIG], fromBlock: s, toBlock: e }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getLogs timeout 20s')), 20000))
      ]);
      for (const lg of logs) {
        if (!allMintTxs.includes(lg.transactionHash)) allMintTxs.push(lg.transactionHash);
      }
    } catch (err) {
      console.log(`  HHI getLogs ${s}-${e}: ${err.shortMessage || err.message}`);
    }
  }
  // Take the LAST 200 unique txs (most recent = active positions)
  const mintTxs = allMintTxs.slice(-200);

  if (mintTxs.length === 0) {
    console.log(`  HHI: no Mint events found for ${poolAddr.slice(0, 14)}`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }
  console.log(`  HHI: ${mintTxs.length} unique mint txs for ${poolAddr.slice(0, 14)}`);

  // Get tx receipts in batches of 50, find NFPM tokenIds
  const poolTokenIds = [];
  for (let i = 0; i < mintTxs.length; i += 50) {
    const batch = mintTxs.slice(i, i + 50);
    const receipts = await Promise.allSettled(
      batch.map(txHash =>
        Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise((_, rej) => setTimeout(() => rej(new Error('receipt timeout 10s')), 10000))
        ]).catch(() => null)
      )
    );
    for (let j = 0; j < receipts.length; j++) {
      const r = receipts[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      for (const log of r.value.logs) {
        if (log.address.toLowerCase() !== V3_NFPM.toLowerCase()) continue;
        if (log.topics[0] !== INC_LIQ_SIG) continue;
        const tokenId = BigInt(log.topics[1]);
        if (!poolTokenIds.find(p => p.tokenId === tokenId)) {
          poolTokenIds.push({ tokenId });
        }
        break;
      }
    }
  }

  if (poolTokenIds.length === 0) {
    console.log(`  HHI: no NFPM tokenIds found via tx receipts for ${poolAddr.slice(0, 14)}`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }
  console.log(`  HHI: ${poolTokenIds.length} unique tokenIds from receipts`);

  // Call positions() to get current liquidity
  for (let i = 0; i < poolTokenIds.length; i += 20) {
    const batch = poolTokenIds.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(p =>
        Promise.race([
          nfpm.positions(p.tokenId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('positions timeout 10s')), 10000))
        ]).then(pos => ({ ...p, liquidity: pos[7] })).catch(() => ({ ...p, liquidity: 0n }))
      )
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        poolTokenIds[i + j].liquidity = results[j].value.liquidity;
      }
    }
  }

  // Filter active positions
  const active = poolTokenIds.filter(p => p.liquidity > 0n);
  console.log(`  HHI: ${active.length}/${poolTokenIds.length} positions active`);
  if (active.length < 2) {
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

  // Find owners via Transfer events
  const ownerLiq = {};
  for (let i = 0; i < active.length; i += 10) {
    const batch = active.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(p => {
        const topic2 = '0x' + p.tokenId.toString(16).padStart(64, '0');
        return Promise.race([
          provider.getLogs({ address: V3_NFPM, topics: [TRANSFER_SIG, null, null, topic2], fromBlock: 0, toBlock: head }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('transfer logs timeout 10s')), 10000))
        ]).then(logs => {
          if (logs.length > 0) {
            return { owner: '0x' + logs[logs.length - 1].topics[2].slice(26), liquidity: p.liquidity };
          }
          return null;
        }).catch(() => null)
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.owner) {
        const o = r.value.owner.toLowerCase();
        ownerLiq[o] = (ownerLiq[o] || 0n) + r.value.liquidity;
      }
    }
  }

  const providerCount = Object.keys(ownerLiq).length;
  const totalLiq = Object.values(ownerLiq).reduce((s, v) => s + v, 0n);

  if (providerCount < 2 || totalLiq === 0n) {
    console.log(`  HHI: only ${providerCount} providers found`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

  // Compute HHI
  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / totalLiq) / 100;
    return s + share * share;
  }, 0);

  poolState.hhiScore = Math.round(hhi);
  poolState.hhiProviderCount = providerCount;
  poolState.hhiChecked = true;
  poolState.hhiChecking = false;

  // Penalty: HHI > 2500 = concentrated. Scale: 0 to -50
  let penalty = 0;
  if (hhi > 2500) {
    penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);
  }
  poolState.hhiPenalty = penalty;
  poolState.hhiData = {
    hhi: Math.round(hhi),
    providers: providerCount,
    penalty,
  };
  console.log(`  HHI for ${poolAddr.slice(0, 14)}: HHI=${Math.round(hhi)} providers=${providerCount} penalty=${penalty}`);
  return penalty;
}

// ===== V4 HHI (via PoolManager ModifyLiquidity events) =====
const V4_NFPM_HHI = '0x58daec3116aae6d93017baaea7749052e8a04fa7'.toLowerCase();
const V4_POOLMANAGER_HHI = '0x8366a39cc670b4001a1121b8f6a443a643e40951'.toLowerCase();
const MODIFY_LIQ_SIG = topicId('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');

async function computeV4HHIPenalty(poolId, poolState) {
  if (poolState.hhiChecked) return (poolState.hhiPenalty || 0);
  if (poolState.hhiChecking) return 0;
  poolState.hhiChecking = true;

  const result = await Promise.race([
    _computeV4HHIImpl(poolId, poolState),
    new Promise((_, rej) => setTimeout(() => rej(new Error('V4 HHI timeout (180s)')), 180000))
  ]).catch(err => {
    console.log(`  V4 HHI error for ${poolId.slice(0, 18)}: ${err.shortMessage || err.message}`);
    poolState.hhiChecking = false;
    poolState.hhiFailed = (poolState.hhiFailed || 0) + 1;
    poolState.hhiFailedAt = Date.now();
    return 0;
  });
  return result;
}

async function _computeV4HHIImpl(poolId, poolState) {
  const provider = await getHHIProvider();
  const head = await provider.getBlockNumber();
  const step = 500_000;
  const v4nfpm = new Contract(V4_NFPM_HHI, [
    'function getPositionLiquidity(uint256) view returns (uint128)',
    'function ownerOf(uint256) view returns (address)',
  ], provider);

  // Validate poolId — must be valid bytes32 hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    console.log(`  V4 HHI skip ${poolId.slice(0, 18)}: invalid bytes32`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

  // Collect ModifyLiquidity events — use raw send() to bypass ethers filter normalization
  const allMods = [];
  let fetchErrors = 0;
  for (let s = 0; s <= head; s += step) {
    try {
      const rawFilter = {
        address: V4_POOLMANAGER_HHI,
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

  if (fetchErrors > 0) {
    console.log(`  V4 HHI ${poolId.slice(0, 18)}: getLogs had ${fetchErrors} errors, events found: ${allMods.length}`);
  }

  if (allMods.length === 0) {
    console.log(`  V4 HHI ${poolId.slice(0, 18)}: no ModifyLiquidity events found`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

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
      if (rlog.address.toLowerCase() !== V4_NFPM_HHI) continue;
      if (rlog.topics[0] !== TRANSFER_SIG) continue;
      if (rlog.topics[3]) tokenIds.add(BigInt(rlog.topics[3]).toString());
    }
  }

  if (tokenIds.size < 2) {
    console.log(`  V4 HHI ${poolId.slice(0, 18)}: only ${tokenIds.size} tokenIds from ModifyLiquidity`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

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
    console.log(`  V4 HHI ${poolId.slice(0, 18)}: only ${pc} providers with active positions`);
    poolState.hhiChecked = true;
    poolState.hhiChecking = false;
    return 0;
  }

  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / tl) / 100;
    return s + share * share;
  }, 0);

  poolState.hhiScore = Math.round(hhi);
  poolState.hhiProviderCount = pc;
  poolState.hhiChecked = true;
  poolState.hhiChecking = false;

  let penalty = 0;
  if (hhi > 2500) penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);
  poolState.hhiPenalty = penalty;
  poolState.hhiData = { hhi: Math.round(hhi), providers: pc, penalty };
  console.log(`  V4 HHI for ${poolId.slice(0, 18)}: HHI=${Math.round(hhi)} providers=${pc} penalty=${penalty}`);
  return penalty;
}

// ===== FILTERS =====
function passesFilters(po) {
  const minTvl   = cfgSc('minTvlUsd')   || 5000;
  const minVol   = cfgSc('minVolume24h') || 10000;
  const minSwaps = cfgSc('minSwaps24h')  || 50;
  const excludeV2 = po.version === 'v2' || (po.labels && po.labels.includes('v2'));

  // Dead-token guard: no buys OR insufficient activity
  if (po.volume24h === 0 || po.buys24h === 0 || po.swaps24h < 5) return false;

  // Extreme-pump guard: age < 24h AND (vol/TVL > 15x OR |priceChange| > 500%)
  const ageHours = po.pairCreatedAt ? (Date.now() - po.pairCreatedAt) / 3600000 : Infinity;
  const volTvlRatio = po.tvlUsd > 0 ? po.volume24h / po.tvlUsd : 0;
  const priceChangeAbs = Math.abs(po.priceChange24h ?? 0);
  if (ageHours < 24 && (volTvlRatio > 15 || priceChangeAbs > 500)) return false;

  return po.tvlUsd >= minTvl && po.volume24h >= minVol && po.swaps24h >= minSwaps && !excludeV2;
}

// ===== GMGN CHECK =====
async function checkPoolGMGN(po) {
  if (po.gmgnChecked) return;
  const tokenAddr = po.baseToken?.address;
  if (!tokenAddr) { po.gmgnChecked = true; return; }
  const g = await checkGMGN(tokenAddr);
  po.gmgnChecked = true;
  if (g) {
    po.gmgnFlags = g.flags;
  }
}

// ===== TELEGRAM NOTIFICATION =====
async function sendCandidateNotification(po) {
  const b = po.baseToken;
  const q = po.quoteToken;
  const ver = po.labels?.join('/') || po.version || '?';
  const sym = `${b?.symbol || '?'}/${q?.symbol || '?'} (${ver})`;
  const tgLink = `https://t.me/robinhoodchain_whale_bot?start=${b?.address || ''}`;

  const lines = [
    `🏆 <b>LP Candidate</b> — ${sym}`,
    ``,
    `Token: <code>${b?.address || '?'}</code>`,
    `Pool: <code>${po.pairAddress}</code>`,
    ``,
    `📊 <b>Stats</b>`,
    `TVL: $${(po.tvlUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `Vol 24h: $${(po.volume24h || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `Swaps 24h: ${(po.swaps24h || 0).toLocaleString()}`,
    `Vol/TVL: ${(po._scoreBreakdown?.volTvlRatio || 0).toFixed(2)}x`,
    `Price 24h: ${po.priceChange24h !== null && po.priceChange24h !== undefined ? `${po.priceChange24h >= 0 ? '+' : ''}${po.priceChange24h.toFixed(1)}%` : '?'}`,
    ``,
    `🏅 <b>Score: ${po.score}/100</b>`,
    `  TVL: ${po._scoreBreakdown?.tvl || 0}  Swaps: ${po._scoreBreakdown?.swaps || 0}  Vol/TVL: ${po._scoreBreakdown?.volTvlRatio || 0}`,
    `  Age: ${po._scoreBreakdown?.age || 0}  Price: ${po._scoreBreakdown?.price || 0}  GMGN: ${po._scoreBreakdown?.gmgn || 0}`,
    ``,
  ];

  if (po.gmgnFlags?.length) {
    lines.push(`⚠️ <b>GMGN flags:</b> ${po.gmgnFlags.join(', ')}`);
  } else if (po.gmgnChecked) {
    lines.push(`✅ <b>GMGN:</b> clean`);
  }

  if (po.hhiData) {
    const emoji = po.hhiData.hhi > 2500 ? '⚠️' : '✅';
    lines.push(`${emoji} <b>LP concentration:</b> HHI=${po.hhiData.hhi} | ${po.hhiData.providers} providers${po.hhiData.penalty ? ` | penalty=${po.hhiData.penalty}` : ''}`);
  }

  if (po.socials?.length) {
    const tw = po.socials.find(s => s.type === 'twitter' || s.platform === 'twitter');
    const tg = po.socials.find(s => s.type === 'telegram' || s.platform === 'telegram');
    if (tw) lines.push(`🐦 <a href="https://x.com/${tw.handle || tw.url}">Twitter</a>`);
    if (tg) lines.push(`💬 TG: @${tg.handle || tg.url.replace('https://t.me/', '')}`);
  }

  const explorer = 'https://robinhoodchain.blockscout.com';
  lines.push(``);
  lines.push(`🔗 <a href="https://dexscreener.com/robinhood/${po.pairAddress}">DexScreener</a>`);
  lines.push(`🔗 <a href="${explorer}/address/${b?.address}#code">Contract</a>`);

  await tgScreener(lines.join('\n'));
  po.notified = true;
  console.log(`>>> CANDIDATE: ${sym} — score=${po.score} tvl=${po.tvlUsd} vol24h=${po.volume24h} swaps24h=${po.swaps24h}`);
}

// ===== STATE PERSISTENCE =====
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    state = JSON.parse(raw);
    // Ensure pools is object (not array from old versions)
    if (Array.isArray(state.pools)) state.pools = {};
    console.log(`loaded state: ${Object.keys(state.pools).length} pools, lastDiscovery=${state.lastDiscovery}`);
  } catch {
    state = { pools: {}, lastDiscovery: 0, lastFetch: 0 };
    console.log('no prior state — starting fresh');
  }
  if (!state.autoOpenCooldown) state.autoOpenCooldown = {};
}

function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ===== EVALUATE + NOTIFY =====
async function evaluatePools() {
  let scored = 0, passed = 0, notified = 0;
  const entries = Object.entries(state.pools);

  // ===== DIAGNOSTIK: duplicate token per symbol (per 30 menit) =====
  if (Date.now() - (_lastTokenDiag || 0) > 1800000) {
    _lastTokenDiag = Date.now();
    const tokenCounts = {};
    for (const [, po] of entries) {
      if (!po.baseToken?.address || !po.baseToken?.symbol) continue;
      const sym = po.baseToken.symbol;
      const addr = po.baseToken.address;
      if (!tokenCounts[sym]) tokenCounts[sym] = { unique: new Set(), total: 0 };
      tokenCounts[sym].unique.add(addr);
      tokenCounts[sym].total++;
    }
    for (const [sym, info] of Object.entries(tokenCounts).sort((a, b) => b[1].total - a[1].total)) {
      if (info.unique.size < info.total) {
        const dupes = info.total - info.unique.size;
        console.log(`  TOKEN DIAGNOSTIK: "${sym}" — ${info.total} pool entries, ${info.unique.size} unique token addresses (${dupes} duplikasi pool)`);
      } else if (info.total >= 5) {
        console.log(`  TOKEN DIAGNOSTIK: "${sym}" — ${info.total} pool entries, SEMUA token address UNIK (copycat/berbeda)`);
      }
    }
  }

  for (const [key, po] of entries) {
    if (!po.tvlUsd && !po.volume24h) continue; // no data yet

    // Record TVL/volume snapshot for growth trend tracking
    recordTrendSnapshot(po);

    const { score, breakdown, volTvlRatio } = computeScore(po);
    po.score = score;
    po._scoreBreakdown = breakdown;

    if (!passesFilters(po)) continue;
    passed++;

    // GMGN check for high-potential pools
    if (po.score >= (cfgSc('gmgnMinScore') || 30)) {
      await checkPoolGMGN(po);
    }

    // HHI / LP concentration check for candidate pools (once per pool, TVL > $20K)
    // Retry on failure after 5 min cooldown (hhiFailedAt)
    // NOTE: threshold 15 menyamakan gate score (checkAutoOpenConditions) — sebelumnya
    // pakai minCandidateScore (35) yang menyebabkan token score 15-34 TIDAK PERNAH
    // dapat HHI dan stuck di 'HHI belum valid (pending)' selamanya.

    // --- Retry reset: pools where HHI was checked but returned NO valid data ---
    // Early return paths di _computeHHIImpl (no mints, no tokenIds, <2 active, <2 providers)
    // set hhiChecked=true without hhiData. Ini JALAN BUNTU PERMANEN — tidak akan retry
    // kecuali kita reset hhiChecked setelah cooldown. Reset setelah 6 jam agar pool
    // yang kemudian punya aktivitas bisa dicek ulang.
    if (po.hhiChecked && (po.hhiData === undefined || po.hhiData.hhi === undefined)) {
      const lastRetry = po.hhiRetryAt || 0;
      if (Date.now() - lastRetry > 6 * 3600 * 1000) {
        console.log(`  HHI: resetting hhiChecked for ${po.pairAddress.slice(0, 14)} (prev: no valid data — retry after 6h)`);
        po.hhiChecked = false;
        po.hhiRetryAt = Date.now();
      }
    }
    if (po.score >= 15 && !po.hhiChecked && !po.hhiChecking && po.tvlUsd >= 20000) {
      const cooldownOk = !po.hhiFailedAt || (Date.now() - po.hhiFailedAt) > 300000; // 5 min
      if (!cooldownOk) continue;
      try {
        const isV4 = (po.labels || []).some(l => l.toLowerCase() === 'v4');
        const poolAddr = lc(po.pairAddress);
        const penalty = isV4 ? await computeV4HHIPenalty(poolAddr, po) : await computeHHIPenalty(poolAddr, po);
        if (penalty !== 0) {
          po.score = Math.max(0, po.score + penalty);
          console.log(`  >> HHI penalty: ${penalty} → new score=${po.score}`);
        } else if (po.hhiScore !== undefined) {
          console.log(`  >> HHI OK: ${po.hhiScore} (no penalty)`);
        }
      } catch (err) {
        console.error(`  >> HHI check FAILED for ${po.pairAddress.slice(0, 14)}: ${err.shortMessage || err.message}`);
        po.hhiChecking = false;
        po.hhiFailed = (po.hhiFailed || 0) + 1;
        po.hhiFailedAt = Date.now();
      }
    }

    // Notify if not yet notified and score >= threshold
    const minScore = cfgSc('minCandidateScore') || 40;
    if (!po.notified && po.score >= minScore) {
      await sendCandidateNotification(po);
      notified++;
    }

    // Auto-open (Phase 2):
    // Gates: trend UP, score >= 15, HHI < 9500, GMGN clean, TVL >= $20k, governance OK
    // Exec provider: LP_EXEC_RPC_URL (terpisah dari LP_SCREENER_RPC_URL untuk discovery)
    const sym = po.baseToken?.symbol || '?';
    const gateScore = po.score || 0;
    const gateHhi = po.hhiData?.hhi;
    const gateTvl = po.tvlUsd || 0;
    let gateFail = null;
    if (gateScore < 15) gateFail = `score ${gateScore} < 15`;
    else if (gateHhi === undefined) {
      if (po.hhiChecked) gateFail = `HHI checked but invalid (${po.hhiData ? 'hhi=null' : 'no hhiData'}, permanent)`;
      else if (po.hhiFailed) gateFail = `HHI belum valid (gagal ${po.hhiFailed}x, cooldown ${Math.ceil(Math.max(0, 5 - (Date.now()-po.hhiFailedAt)/60000))}min)`;
      else gateFail = `HHI belum valid (pending)`;
    }
    else if (gateHhi >= 9500) gateFail = `HHI ${gateHhi} >= 9500`;
    else if (!po.gmgnChecked) gateFail = 'GMGN belum dicek';
    else if (po.gmgnFlags && po.gmgnFlags.length > 0) gateFail = `GMGN flagged: ${po.gmgnFlags.join(',')}`;
    else if (gateTvl < 20000) gateFail = `TVL $${gateTvl.toLocaleString()} < $20k`;
    // Gate 0.5: Per-token cooldown — jika token yang SAMA sudah auto-open
    // 2x berturut-turut, jeda 3 jam sebelum boleh auto-open lagi.
    // Dipaksa coba token lain, bukan approve token yang sama terus-menerus.
    if (!gateFail && po.baseToken?.address && state.autoOpenCooldown) {
      const cd = state.autoOpenCooldown[po.baseToken.address];
      if (cd && cd.consecutive >= 2) {
        const elapsed = Date.now() - cd.lastTime;
        const COOLDOWN_MS = 3 * 3600 * 1000;
        if (elapsed < COOLDOWN_MS) {
          const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
          gateFail = `cooldown ${remaining}min (${cd.consecutive}x berturut-turut)`;
        }
      }
    }
    if (gateFail) {
      console.log(`  [gate] ${sym}: ${gateFail}, skip auto-open check`);
    } else {
      const ao = await checkAutoOpenConditions(po);
      if (ao.pass) {
        const execProv = await (process.env.LP_EXEC_RPC_URL
          ? makeProvider('LP_EXEC_RPC_URL')
          : makeProvider('LP_SCREENER_RPC_URL')).catch(() => null);
        const result = await autoOpenExecute(po, execProv);
        // Update cooldown AFTER sukses auto-open
        if (result && po.baseToken?.address) {
          if (!state.autoOpenCooldown) state.autoOpenCooldown = {};
          const addr = po.baseToken.address;
          const prev = state.autoOpenCooldown[addr];
          if (prev && prev.lastToken === addr) {
            // Token yang SAMA seperti sebelumnya — increment consecutive
            state.autoOpenCooldown[addr] = {
              consecutive: (prev.consecutive || 0) + 1,
              lastTime: Date.now(),
              lastToken: addr,
            };
          } else {
            // Token BARU atau berbeda dari sebelumnya — reset ke 1
            state.autoOpenCooldown[addr] = {
              consecutive: 1,
              lastTime: Date.now(),
              lastToken: addr,
            };
          }
          // Bersihkan entry token lain yang sudah lama (optional)
          for (const key of Object.keys(state.autoOpenCooldown)) {
            if (key !== addr && Date.now() - (state.autoOpenCooldown[key].lastTime || 0) > 7 * 86400000) {
              delete state.autoOpenCooldown[key];
            }
          }
        }
      } else {
        console.log(`  [auto-open BLOCKED] ${sym}: ${ao.reason}`);
      }
    }
    scored++;
  }

  if (passed) {
    console.log(`evaluated: ${scored} scored, ${passed} passed filters, ${notified} new candidates`);
  }
  return { scored, passed, notified };
}

// ===== PERIODIC SUMMARY =====
async function sendSummary() {
  const sorted = Object.values(state.pools)
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (!sorted.length) return;

  const lines = [
    `<b>📊 LP Screener Summary</b>`,
    ``,
    `Tracked pools: ${Object.keys(state.pools).length}`,
    `Scored: ${Object.values(state.pools).filter(p => p.score > 0).length}`,
    ``,
    `<b>Top ${Math.min(sorted.length, 5)} by score:</b>`,
  ];

  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const p = sorted[i];
    const b = p.baseToken;
    const q = p.quoteToken;
    const ver = p.labels?.join('/') || p.version || '?';
    lines.push(`${i + 1}. <b>${b?.symbol || '?'}/${q?.symbol || '?'}</b> (${ver}) — ${p.score}/100`);
    lines.push(`   TVL: $${(p.tvlUsd || 0).toLocaleString()} | Vol: $${(p.volume24h || 0).toLocaleString()} | Swaps: ${(p.swaps24h || 0).toLocaleString()}`);
  }

  await tgScreener(lines.join('\n'));
}

// ===== MAIN =====
async function main() {
  console.log('RobinArb LP Screener — DexScreener only\n');

  loadState();

  // Config
  const pollMs          = cfgSc('pollIntervalMs') || 1200000;
  const summaryMins     = cfgSc('summaryIntervalMin') || 360;
  const summaryMs       = summaryMins * 60 * 1000;

  // --- Initial discovery if state is empty ---
  if (!Object.keys(state.pools).length) {
    await runInitialDiscovery();
  } else {
    console.log('\nRefreshing pool data from DexScreener...');
    const updated = await updatePoolData();
    console.log(`Updated ${updated} pools`);
  }

  // --- Initial evaluation ---
  console.log('\n=== Initial Evaluation ===');
  const init = await evaluatePools();
  console.log(`Initial: ${init.passed} passed filters, ${init.notified} new candidates`);

  await tgScreener(
    `🔍 <b>LP Screener online</b> — tracking ${Object.keys(state.pools).length} pools, polling every ${(pollMs / 60000).toFixed(0)}min`
  );

  // --- Schedule loops ---
  let lastFetchRun = Date.now();
  let lastSummaryRun = Date.now();
  let lastV4ScanRun = 0;

  const interval = setInterval(async () => {
    try {
      const now = Date.now();

      // DexScreener data refresh
      if (now - lastFetchRun > pollMs) {
        console.log(`\n${new Date().toISOString().slice(11, 19)} — Refreshing DexScreener data...`);
        const updated = await updatePoolData();
        if (updated) {
          const ev = await evaluatePools();
          saveState();
          console.log(`Updated ${updated} pools, ${ev.passed} pass filters, ${ev.notified} new candidates`);
        }
        lastFetchRun = now;
      }

      // Periodic summary
      if (now - lastSummaryRun > summaryMs) {
        await sendSummary();
        lastSummaryRun = now;
      }

      // V4 pool registry scan (every ~15 min, incremental from last scanned block)
      if (now - lastV4ScanRun > 900_000) {
        try {
          const r = await scanV4Pools();
          console.log(`[v4_registry] ${r.total} pools known (${r.scanned} new this cycle)`);
        } catch (e) {
          console.error(`[v4_registry] scan error: ${e.shortMessage || e.message}`);
        }
        lastV4ScanRun = now;
      }
    } catch (err) {
      const msg = err.shortMessage || err.message;
      console.error('loop error:', msg);
      console.error(err.stack || err);
      await tgScreener(`⚠️ <b>Loop error</b> — auto-open mungkin terganggu\n<code>${msg}</code>`).catch(() => {});
    }
  }, Math.min(pollMs, 60000));

  process.on('SIGINT', () => { console.log('\nshutting down...'); saveState(); clearInterval(interval); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\nshutting down...'); saveState(); clearInterval(interval); process.exit(0); });
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
