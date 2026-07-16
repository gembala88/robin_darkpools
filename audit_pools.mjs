import 'dotenv/config';

const fetchJSON = (url, timeout = 10000) => fetch(url, { signal: AbortSignal.timeout(timeout) }).then(r => r.json());

async function main() {
  const queries = ['robinhood', 'ROBINHOOD', 'cashcat', 'CASHCAT', 'Robinhood',
    'Robinhood Chain', 'HOOD', 'CHAIN', 'CHAINHOOD', 'ROBINHOODCHAIN',
    'TSUKI', 'CLAUDEX', 'LOSS', 'MACRO', 'AGENT', 'ELON', 'MARION', 'IMF'];
  const all = {};
  for (const q of queries) {
    try {
      const r = await fetchJSON('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q));
      if (r.pairs) for (const p of r.pairs.filter(x => x.chainId === 'robinhood')) all[p.pairAddress] = p;
    } catch (e) {}
  }

  // token-profiles → try to find pairs
  const profiles = await fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1');
  for (const p of profiles.filter(x => x.chainId === 'robinhood')) {
    try {
      const r = await fetchJSON('https://api.dexscreener.com/token-pairs/v1/robinhood/' + p.tokenAddress, 5000);
      if (r && r.pairs) for (const pair of r.pairs) all[pair.pairAddress] = pair;
    } catch (e) {}
  }

  // token-boosts → try to find pairs
  const boosts = await fetchJSON('https://api.dexscreener.com/token-boosts/latest/v1');
  for (const b of boosts.filter(x => x.chainId === 'robinhood')) {
    try {
      const r = await fetchJSON('https://api.dexscreener.com/token-pairs/v1/robinhood/' + b.tokenAddress, 5000);
      if (r && r.pairs) for (const pair of r.pairs) all[pair.pairAddress] = pair;
    } catch (e) {}
  }

  const pools = Object.values(all);
  console.log('TOTAL: ' + pools.length + ' unique pools');

  // By base token
  const byAddr = {};
  for (const p of pools) {
    const a = (p.baseToken?.address || '?').toLowerCase();
    const sym = p.baseToken?.symbol || '?';
    byAddr[a] = byAddr[a] || { symbol: sym, addr: a, count: 0, tvl: 0 };
    byAddr[a].count++;
    byAddr[a].tvl += p.liquidity?.usd || 0;
  }

  const sorted = Object.values(byAddr).sort((a, b) => b.tvl - a.tvl);
  console.log('');
  console.log('=== Top tokens by TVL ===');
  for (let i = 0; i < sorted.length && i < 15; i++) {
    const t = sorted[i];
    console.log((i+1) + '. ' + t.symbol.padEnd(14) + ' pools=' + t.count + ' TVL=$' + Math.round(t.tvl).toLocaleString() + ' addr=' + t.addr.slice(0, 14) + '...');
  }

  // Check which tokens passed screening filters ($5K TVL, $10K vol, 50 swaps)
  const pass = pools.filter(p => {
    return (p.liquidity?.usd || 0) >= 5000
      && (p.volume?.h24 || 0) >= 10000
      && ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)) >= 50;
  });
  console.log('');
  console.log('Pools passing current filters (TVL>=$5K, vol>=$10K, swaps>=50): ' + pass.length);

  const passTokens = new Set(pass.map(p => p.baseToken?.symbol).filter(Boolean));
  const passAddrs = new Set(pass.map(p => p.baseToken?.address?.toLowerCase()).filter(Boolean));
  console.log('Unique token SYMBOLS passing: ' + passTokens.size + ' → ' + [...passTokens].join(', '));
  console.log('Unique token ADDRESSES passing: ' + passAddrs.size);

  // What about with min TVL = $1K (more relaxed)?
  const passRelaxed = pools.filter(p => {
    return (p.liquidity?.usd || 0) >= 1000
      && (p.volume?.h24 || 0) >= 1000
      && ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)) >= 10;
  });
  console.log('');
  console.log('With RELAXED filters (TVL>=$1K, vol>=$1K, swaps>=10): ' + passRelaxed.length);
  const relaxTokens = new Set(passRelaxed.map(p => p.baseToken?.symbol).filter(Boolean));
  console.log('Unique token SYMBOLS (relaxed): ' + relaxTokens.size + ' → ' + [...relaxTokens].join(', '));

  // Check token-profiles: do any have pairs?
  const profilesWithPairs = profiles.filter(x => x.chainId === 'robinhood').filter(p => {
    return Object.values(all).some(pair => pair.baseToken?.address?.toLowerCase() === p.tokenAddress.toLowerCase());
  });
  console.log('');
  console.log('Token-profiles that ALSO have DEX pairs: ' + profilesWithPairs.length + '/' + profiles.filter(x => x.chainId === 'robinhood').length);
  for (const p of profilesWithPairs) {
    const sym = Object.values(all).find(pair => pair.baseToken?.address?.toLowerCase() === p.tokenAddress.toLowerCase())?.baseToken?.symbol;
    console.log('  ' + p.tokenAddress.slice(0, 14) + '... → ' + sym);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
