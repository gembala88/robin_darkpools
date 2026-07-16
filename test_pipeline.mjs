import 'dotenv/config';
import { Contract, id as topicId } from 'ethers';
import { makeProvider } from './provider.js';

// ===== CONSTANTS =====
const V3_NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3'.toLowerCase();
const V4_NFPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'.toLowerCase();
const V4_POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'.toLowerCase();
const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search?q=';
const DEXSCREENER_TOKEN_PAIRS = 'https://api.dexscreener.com/token-pairs/v1/';
const DEXSCREENER_PROFILES = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEXSCREENER_BOOSTS = 'https://api.dexscreener.com/token-boosts/latest/v1';

// Event signatures
const POOL_MINT_SIG = topicId('Mint(address,address,int24,int24,uint128,uint256,uint256)');
const INC_LIQ_SIG = topicId('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const TRANSFER_SIG = topicId('Transfer(address,address,uint256)');
const MODIFY_LIQ_SIG = topicId('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');

// ===== HELPERS =====
const fetchJSON = (url, timeout = 10000) => fetch(url, { signal: AbortSignal.timeout(timeout) }).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== STEP 1: DISCOVER TOKENS =====
async function discoverTokens() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 1: TOKEN DISCOVERY');
  console.log('='.repeat(60));

  // 1a. Search endpoint with known queries
  const knownQueries = [
    'robinhood', 'ROBINHOOD', 'Robinhood', 'cashcat', 'CASHCAT',
    'HOOD', 'CLAUDEX', 'AGENTOS', 'CHAIN', 'CHAINHOOD', 'ROBINHOODCHAIN',
    'TSUKI', 'LOSS', 'MACRO', 'AGENT', 'MARION', 'IMF', 'SCRY', 'MAQU', 'RHAGENT', 'ELON',
  ];
  const poolMap = {};
  for (const q of knownQueries) {
    try {
      const r = await fetchJSON(DEXSCREENER_SEARCH + encodeURIComponent(q));
      if (r.pairs) for (const p of r.pairs.filter(x => x.chainId === 'robinhood')) {
        poolMap[p.pairAddress] = p;
      }
    } catch (e) {}
  }
  console.log(`  Known-keyword search: ${Object.keys(poolMap).length} unique pools`);

  // 1b. Token profiles → extract symbols for more searches + check pairs
  const profiles = await fetchJSON(DEXSCREENER_PROFILES);
  const rhProfiles = profiles.filter(x => x.chainId === 'robinhood');
  console.log(`  Token profiles: ${rhProfiles.length} Robinhood entries`);
  for (const profile of rhProfiles) {
    // Extract symbol from description/name
    const desc = profile.description || '';
    const words = desc.match(/\$([A-Z0-9_]{2,20})/g);
    if (words) for (const w of words) knownQueries.push(w.replace('$', ''));

    // Check token-pairs for this address
    try {
      const r = await fetchJSON(DEXSCREENER_TOKEN_PAIRS + 'robinhood/' + profile.tokenAddress, 5000);
      if (Array.isArray(r)) for (const p of r) poolMap[p.pairAddress] = p;
    } catch (e) {}
  }

  // 1c. Token boosts → extract tokens + check pairs
  const boosts = await fetchJSON(DEXSCREENER_BOOSTS);
  const rhBoosts = boosts.filter(x => x.chainId === 'robinhood');
  console.log(`  Token boosts: ${rhBoosts.length} Robinhood entries`);
  for (const b of rhBoosts) {
    try {
      const r = await fetchJSON(DEXSCREENER_TOKEN_PAIRS + 'robinhood/' + b.tokenAddress, 5000);
      if (Array.isArray(r)) for (const p of r) poolMap[p.pairAddress] = p;
    } catch (e) {}
  }

  const pools = Object.values(poolMap);
  const validPools = pools.filter(p => p.liquidity?.usd > 0);
  console.log(`  Total pools: ${pools.length}, with TVL>0: ${validPools.length}`);
  const tokens = new Set(validPools.map(p => p.baseToken?.address?.toLowerCase()).filter(Boolean));
  console.log(`  Unique base tokens: ${tokens.size}`);
  return validPools;
}

// ===== STEP 2: SCORE & GUARDS =====
function classifyPool(p) {
  const labels = p.labels?.map(l => l.toLowerCase()) || [];
  const isV4 = labels.includes('v4');
  const isV3 = labels.includes('v3');
  const dex = (p.dexId || '').toLowerCase();

  // Age in hours
  const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : Infinity;
  const tvl = p.liquidity?.usd || 0;
  const vol24h = p.volume?.h24 || 0;
  const priceChange24h = Math.abs(p.priceChange?.h24 || 0);
  const txns24h = ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0));
  const volTvlRatio = tvl > 0 ? vol24h / tvl : 0;

  // GUARD 1: Dead token (vol24h == 0 OR txns < 5)
  const isDead = vol24h === 0 || txns24h < 5;

  // GUARD 2: Extreme pump (age < 24h AND (vol/TVL > 15x OR |priceChange| > 500%))
  const isExtremePump = ageHours < 24 && (volTvlRatio > 15 || priceChange24h > 500);

  return {
    isV4, isV3, dex, ageHours, tvl, vol24h, priceChange24h, txns24h, volTvlRatio,
    isDead, isExtremePump,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    pairAddress: p.pairAddress,
    url: p.url,
    pairCreatedAt: p.pairCreatedAt,
  };
}

// ===== STEP 3: V3 HHI =====
async function computeV3HHI(provider, poolAddr, head) {
  const step = 500_000;
  const nfpm = new Contract(V3_NFPM, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
    'function ownerOf(uint256) view returns (address)',
  ], provider);

  const allMintTxs = [];
  for (let s = 0; s <= head; s += step) {
    try {
      const logs = await provider.getLogs({ address: poolAddr, topics: [POOL_MINT_SIG], fromBlock: s, toBlock: Math.min(s + step - 1, head) });
      for (const lg of logs) {
        if (!allMintTxs.includes(lg.transactionHash)) allMintTxs.push(lg.transactionHash);
      }
    } catch (e) {}
  }
  const mintTxs = allMintTxs.slice(-200);
  if (mintTxs.length === 0) return null;

  const poolTokenIds = [];
  for (let i = 0; i < mintTxs.length; i += 50) {
    const batch = mintTxs.slice(i, i + 50);
    const receipts = await Promise.allSettled(
      batch.map(txHash => provider.getTransactionReceipt(txHash).catch(() => null))
    );
    for (let j = 0; j < receipts.length; j++) {
      const r = receipts[j];
      if (r.status !== 'fulfilled' || !r.value) continue;
      for (const log of r.value.logs) {
        if (log.address.toLowerCase() !== V3_NFPM) continue;
        if (log.topics[0] !== INC_LIQ_SIG) continue;
        const tokenId = BigInt(log.topics[1]);
        if (!poolTokenIds.find(p => p.tokenId === tokenId)) poolTokenIds.push({ tokenId });
        break;
      }
    }
  }

  if (poolTokenIds.length === 0) return null;

  for (let i = 0; i < poolTokenIds.length; i += 20) {
    const batch = poolTokenIds.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(p => nfpm.positions(p.tokenId).then(pos => ({ ...p, liquidity: pos[7] })).catch(() => ({ ...p, liquidity: 0n })))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') poolTokenIds[i + j].liquidity = results[j].value.liquidity;
    }
  }

  const active = poolTokenIds.filter(p => p.liquidity > 0n);
  if (active.length < 2) return null;

  const ownerLiq = {};
  for (let i = 0; i < active.length; i += 10) {
    const batch = active.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(p => nfpm.ownerOf(p.tokenId).then(owner => ({ owner: owner.toLowerCase(), liquidity: p.liquidity })).catch(() => null))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        ownerLiq[r.value.owner] = (ownerLiq[r.value.owner] || 0n) + r.value.liquidity;
      }
    }
  }

  const pc = Object.keys(ownerLiq).length;
  const tl = Object.values(ownerLiq).reduce((s, v) => s + v, 0n);
  if (pc < 2 || tl === 0n) return null;

  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / tl) / 100;
    return s + share * share;
  }, 0);

  let penalty = 0;
  if (hhi > 2500) penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);

  return { hhi: Math.round(hhi), providers: pc, penalty };
}

// ===== STEP 4: V4 HHI =====
async function computeV4HHI(provider, poolId, head) {
  const step = 500_000;
  const v4nfpm = new Contract(V4_NFPM, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
    'function ownerOf(uint256) view returns (address)',
  ], provider);

  const allMods = [];
  for (let s = 0; s <= head; s += step) {
    try {
      const logs = await provider.getLogs({
        address: V4_POOLMANAGER,
        topics: [MODIFY_LIQ_SIG, poolId],
        fromBlock: s,
        toBlock: Math.min(s + step - 1, head),
      });
      allMods.push(...logs);
    } catch (e) {}
  }

  // Filter for positive amounts (liquidity added). Data layout: tickLower(32B) + tickUpper(32B) + amount(int256,32B) + salt(32B)
  const tokenIds = new Set();
  for (const lg of allMods) {
    const amountHex = '0x' + lg.data.slice(130, 194);
    const amt = BigInt(amountHex);
    const MAX_INT255 = 1n << 255n;
    const amount = amt >= MAX_INT255 ? amt - (1n << 256n) : amt;
    if (amount <= 0n) continue;

    const receipt = await provider.getTransactionReceipt(lg.transactionHash);
    if (!receipt) continue;
    for (const rlog of receipt.logs) {
      if (rlog.address.toLowerCase() !== V4_NFPM) continue;
      if (rlog.topics[0] !== TRANSFER_SIG) continue;
      if (rlog.topics[3]) { // tokenId is topic[3] (indexed uint256)
        tokenIds.add(BigInt(rlog.topics[3]).toString());
      }
    }
  }

  if (tokenIds.size < 2) return null;

  const ownerLiq = {};
  const ids = [...tokenIds].map(s => BigInt(s));
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(async tid => {
        try {
          const [pos, owner] = await Promise.all([
            v4nfpm.positions(tid),
            v4nfpm.ownerOf(tid),
          ]);
          const liq = pos[7];
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
  if (pc < 2 || tl === 0n) return null;

  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / tl) / 100;
    return s + share * share;
  }, 0);

  let penalty = 0;
  if (hhi > 2500) penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);

  return { hhi: Math.round(hhi), providers: pc, penalty };
}

// ===== STEP 5: GMGN CHECK =====
async function runGMGN(tokenAddr) {
  try {
    const mod = await import('./gmgn.js');
    if (typeof mod.checkGMGN === 'function') {
      return await mod.checkGMGN(tokenAddr);
    }
  } catch (e) { /* gmgn not available — silent fallback */ }
  return null;
}

// ===== MAIN =====
async function main() {
  console.log('ROBINHOOD CHAIN — FULL PIPELINE TEST');
  console.log('NOTE: GMGN hanya berjalan di VPS (API key). Di lokal = skip.');

  // Step 1: Discover
  const pools = await discoverTokens();
  console.log(`\nPools with TVL > 0: ${pools.length}`);

  // Step 2: Score & Guard each pool
  console.log('\n' + '='.repeat(60));
  console.log('STEP 2: CLASSIFY + GUARDS');
  console.log('='.repeat(60));

  const classified = pools.map(p => ({ pool: p, info: classifyPool(p) }));

  // Dedup: keep only the highest-TVL pool per base token
  const byToken = {};
  for (const { pool, info } of classified) {
    const addr = pool.baseToken?.address?.toLowerCase();
    if (!addr) continue;
    if (!byToken[addr] || info.tvl > byToken[addr].info.tvl) {
      byToken[addr] = { pool, info };
    }
  }

  const candidates = Object.entries(byToken).map(([addr, data]) => ({
    symbol: data.pool.baseToken?.symbol,
    address: addr,
    info: data.info,
    pool: data.pool,
  }));

  // Sort by TVL descending
  candidates.sort((a, b) => b.info.tvl - a.info.tvl);

  // Show ALL candidates with guard status
  console.log(`\n${'TOKEN'.padEnd(14)} ${'TVL'.padEnd(12)} ${'VOL24H'.padEnd(12)} ${'AGEh'.padEnd(8)} ${'V/TVL'.padEnd(8)} ${'DEAD?'.padEnd(6)} ${'PUMP?'.padEnd(6)} ${'DEX'}  ${'V'}`);
  console.log('-'.repeat(90));
  let passed = 0, rejected = 0;
  for (const c of candidates) {
    const s = c.symbol || '?';
    const tvl = '$' + (c.info.tvl || 0).toLocaleString();
    const vol = '$' + (c.info.vol24h || 0).toLocaleString();
    const age = c.info.ageHours < 9999 ? (c.info.ageHours < 1 ? '<1h' : Math.round(c.info.ageHours) + 'h') : 'old';
    const vt = c.info.volTvlRatio.toFixed(1) + 'x';
    const dead = c.info.isDead ? '💀' : '✅';
    const pump = c.info.isExtremePump ? '🔥' : '✅';
    const dex = c.info.dex;
    const ver = c.info.isV4 ? '4' : c.info.isV3 ? '3' : '?';
    console.log(`${(s||'?').padEnd(14)} ${tvl.padEnd(12)} ${vol.padEnd(12)} ${(age+'').padEnd(8)} ${vt.padEnd(8)} ${dead.padEnd(6)} ${pump.padEnd(6)} ${dex.padEnd(8)} ${ver}`);
    if (!c.info.isDead && !c.info.isExtremePump) passed++;
    else rejected++;
  }
  console.log('-'.repeat(90));
  console.log(`PASSED: ${passed} | REJECTED: ${rejected} | TOTAL: ${candidates.length}`);

  // Step 3: HHI for passed candidates with TVL > $50K
  console.log('\n' + '='.repeat(60));
  console.log('STEP 3: HHI CHECK (TVL > $50K)');
  console.log('='.repeat(60));

  const provider = await makeProvider('SCREENER_RPC_URL');
  const head = await provider.getBlockNumber();

  const hhiResults = {};
  for (const c of candidates) {
    if (c.info.isDead || c.info.isExtremePump) continue;
    if (c.info.tvl < 50000) { console.log(`  ${(c.symbol||'?').padEnd(12)} TVL=$${c.info.tvl.toLocaleString()} → skip HHI (TVL < $50K)`); continue; }

    const poolAddr = c.pool.pairAddress;
    console.log(`  ${(c.symbol||'?').padEnd(12)} TVL=$${c.info.tvl.toLocaleString()} → computing HHI...`);
    let hhi = null;
    if (c.info.isV4) {
      // For V4, pairAddress IS the poolId
      hhi = await computeV4HHI(provider, poolAddr, head);
    } else {
      // For V3 (or unknown), try V3 path
      hhi = await computeV3HHI(provider, poolAddr, head);
    }

    if (hhi) {
      hhiResults[c.symbol] = hhi;
      console.log(`    → HHI=${hhi.hhi} providers=${hhi.providers} penalty=${hhi.penalty}`);
    } else {
      console.log(`    → HHI: not enough data (< 2 active positions)`);
    }
  }

  // Step 4: GMGN check (only if API key present)
  console.log('\n' + '='.repeat(60));
  console.log('STEP 4: GMGN SECURITY CHECK');
  console.log('='.repeat(60));
  const gmgnResults = {};
  for (const c of candidates) {
    if (c.info.isDead || c.info.isExtremePump) continue;
    const tokenAddr = c.address;
    const result = await runGMGN(tokenAddr);
    if (result) {
      gmgnResults[c.symbol] = result;
      const flagStr = result.flags?.join(', ') || 'none';
      console.log(`  ${(c.symbol||'?').padEnd(12)} → ${result.isRisky ? '⚠️ RISKY' : '✅ OK'} flags=${flagStr}`);
    } else {
      console.log(`  ${(c.symbol||'?').padEnd(12)} → SKIP (no API key)`);
    }
  }

  // Step 5: FINAL SUMMARY
  console.log('\n' + '='.repeat(60));
  console.log('FINAL RESULTS');
  console.log('='.repeat(60));

  const finalists = candidates.filter(c => !c.info.isDead && !c.info.isExtremePump);
  console.log(`\n✅ PASSED all guards: ${finalists.length}/${candidates.length} tokens`);
  console.log(`❌ REJECTED (dead/pump): ${rejected} tokens`);

  console.log('\n--- TOP 15 FINAL CANDIDATES (ranked by TVL) ---');
  console.log(`${'#'.padEnd(3)} ${'TOKEN'.padEnd(14)} ${'TVL'.padEnd(12)} ${'VOL24H'.padEnd(12)} ${'AGE'.padEnd(8)} ${'HHI'.padEnd(6)} ${'PEN'.padEnd(5)} ${'GMGN'.padEnd(8)} ${'DEX/V'.padEnd(8)}`);
  console.log('-'.repeat(85));
  for (let i = 0; i < Math.min(finalists.length, 15); i++) {
    const c = finalists[i];
    const sym = c.symbol || '?';
    const tvl = '$' + (c.info.tvl || 0).toLocaleString();
    const vol = '$' + (c.info.vol24h || 0).toLocaleString();
    const age = c.info.ageHours < 1 ? '<1h' : Math.round(c.info.ageHours) + 'h';
    const hhi = hhiResults[c.symbol] ? `${hhiResults[c.symbol].hhi}` : '-';
    const pen = hhiResults[c.symbol] ? `${hhiResults[c.symbol].penalty}` : '0';
    const gmgn = gmgnResults[c.symbol] ? (gmgnResults[c.symbol].isRisky ? '⚠️' : '✅') : '?';
    const ver = c.info.isV4 ? 'V4' : c.info.isV3 ? 'V3' : '?';
    console.log(`${(i+1+'').padEnd(3)} ${sym.padEnd(14)} ${tvl.padEnd(12)} ${vol.padEnd(12)} ${age.padEnd(8)} ${hhi.padEnd(6)} ${pen.padEnd(5)} ${gmgn.padEnd(8)} ${ver}`);
  }

  if (rejected > 0) {
    console.log('\n--- REJECTED TOKENS (for review) ---');
    for (const c of candidates) {
      if (c.info.isDead || c.info.isExtremePump) {
        const reasons = [];
        if (c.info.isDead) reasons.push('💀 dead (vol=0 or txns<5)');
        if (c.info.isExtremePump) reasons.push('🔥 extreme pump (age<24h & vol/TVL>' + c.info.volTvlRatio.toFixed(1) + 'x)');
        console.log(`  ${(c.symbol||'?').padEnd(12)} TVL=$${c.info.tvl.toLocaleString()} ${reasons.join(', ')}`);
      }
    }
  }

  // Cleanup
  provider.destroy();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
