import 'dotenv/config';
import fs from 'node:fs';
import { id as topicId, getAddress, AbiCoder } from 'ethers';
import { UC } from './config.js';
import { tgScreener } from './telegram.js';
import { checkGMGN } from './gmgn.js';

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

// ===== HELPERS =====
const coder = AbiCoder.defaultAbiCoder();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (a) => a.toLowerCase();

const DS_SEARCH_TERMS = cfgDS('searchTerms') || ['robinhood', 'cashcat', 'ROBINHOOD'];

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

// ===== INITIAL DISCOVERY (DexScreener search ONLY — no on-chain scan) =====
async function runInitialDiscovery() {
  console.log('\n=== Initial LP Pool Discovery ===');

  // Seed from DexScreener search (26-28 relevant pools, confirmed)
  console.log('Searching DexScreener for initial pools...');
  for (const term of DS_SEARCH_TERMS) {
    const j = await fetchDexScreener(`/search?q=${encodeURIComponent(term)}`);
    if (!j?.pairs) continue;
    for (const p of j.pairs) {
      if (p.chainId !== 'robinhood') continue;
      const addr = lc(p.pairAddress);
      if (!state.pools[addr]) {
        state.pools[addr] = poolFromDSPair(p);
        state.pools[addr].discoveredAt = Date.now();
      }
    }
    console.log(`  "${term}": ${j.pairs.filter(p => p.chainId === 'robinhood').length} robinhood pools`);
  }

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

// ===== FILTERS =====
function passesFilters(po) {
  const minTvl   = cfgSc('minTvlUsd')   || 5000;
  const minVol   = cfgSc('minVolume24h') || 10000;
  const minSwaps = cfgSc('minSwaps24h')  || 50;
  const excludeV2 = po.version === 'v2' || (po.labels && po.labels.includes('v2'));
  return po.tvlUsd >= minTvl && po.volume24h >= minVol && po.swaps24h >= minSwaps && !excludeV2;
}

// ===== GMGN CHECK =====
async function checkPoolGMGN(po) {
  if (po.gmgnChecked) return;
  const tokenAddr = po.baseToken?.address;
  if (!tokenAddr) return;
  const g = await checkGMGN(tokenAddr);
  if (g) {
    po.gmgnChecked = true;
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

  for (const [key, po] of entries) {
    if (!po.tvlUsd && !po.volume24h) continue; // no data yet

    const { score, breakdown, volTvlRatio } = computeScore(po);
    po.score = score;
    po._scoreBreakdown = breakdown;

    if (!passesFilters(po)) continue;
    passed++;

    // GMGN check for high-potential pools
    if (po.score >= (cfgSc('gmgnMinScore') || 30)) {
      await checkPoolGMGN(po);
    }

    // Notify if not yet notified and score >= threshold
    const minScore = cfgSc('minCandidateScore') || 40;
    if (!po.notified && po.score >= minScore) {
      await sendCandidateNotification(po);
      notified++;
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
    } catch (err) {
      console.error('loop error:', err.shortMessage || err.message);
    }
  }, Math.min(pollMs, 60000));

  process.on('SIGINT', () => { console.log('\nshutting down...'); saveState(); clearInterval(interval); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\nshutting down...'); saveState(); clearInterval(interval); process.exit(0); });
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
