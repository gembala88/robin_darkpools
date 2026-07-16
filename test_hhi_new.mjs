import 'dotenv/config';
import { Contract, id as topicId } from 'ethers';
import { makeProvider } from './provider.js';

const V3_NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3';
const POOL_MINT_SIG = topicId('Mint(address,address,int24,int24,uint128,uint256,uint256)');
const INC_LIQ_SIG = topicId('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const TRANSFER_SIG = topicId('Transfer(address,address,uint256)');

async function computeHHIPenalty(poolAddr, poolName, tokenName) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  HHI Test: ${poolName} — ${tokenName}`);
  console.log(`${'='.repeat(70)}`);

  const provider = await makeProvider('SCREENER_RPC_URL');
  const head = await provider.getBlockNumber();
  const step = 500_000;
  const nfpm = new Contract(V3_NFPM, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
  ], provider);

  console.log(`\n--- Step 1: Collecting Mint events ---`);
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
      console.log(`  chunk ${s}-${e}: ${err.shortMessage || err.message}`);
    }
  }
  const mintTxs = allMintTxs.slice(-200);
  console.log(`  Total Mint txs: ${allMintTxs.length}, sampling last ${mintTxs.length}`);
  if (mintTxs.length === 0) {
    console.log(`  >> No Mint events (might be V4 pool?)`);
    return;
  }

  console.log(`\n--- Step 2: Getting tx receipts ---`);
  const poolTokenIds = [];
  for (let i = 0; i < mintTxs.length; i += 50) {
    const batch = mintTxs.slice(i, i + 50);
    const receipts = await Promise.allSettled(
      batch.map(txHash => Promise.race([
        provider.getTransactionReceipt(txHash),
        new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 10000))
      ]).catch(() => null))
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
  console.log(`  TokenIds found: ${poolTokenIds.length}`);
  if (poolTokenIds.length === 0) {
    console.log(`  >> No NFPM tokenIds`);
    return;
  }

  console.log(`\n--- Step 3: positions() ---`);
  for (let i = 0; i < poolTokenIds.length; i += 20) {
    const batch = poolTokenIds.slice(i, i + 20);
    const results = await Promise.allSettled(
      batch.map(p => Promise.race([
        nfpm.positions(p.tokenId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 10000))
      ]).then(pos => ({ ...p, liquidity: pos[7] })).catch(() => ({ ...p, liquidity: 0n })))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        poolTokenIds[i + j].liquidity = results[j].value.liquidity;
      }
    }
  }

  const active = poolTokenIds.filter(p => p.liquidity > 0n);
  console.log(`  Active: ${active.length}/${poolTokenIds.length}`);
  if (active.length < 2) {
    console.log(`  >> Insufficient active positions`);
    return;
  }

  console.log(`\n--- Step 4: Owners via Transfer ---`);
  const ownerLiq = {};
  for (let i = 0; i < active.length; i += 10) {
    const batch = active.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(p => {
        const t2 = '0x' + p.tokenId.toString(16).padStart(64, '0');
        return Promise.race([
          provider.getLogs({ address: V3_NFPM, topics: [TRANSFER_SIG, null, null, t2], fromBlock: 0, toBlock: head }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 10000))
        ]).then(logs => {
          if (logs.length > 0) return { owner: '0x' + logs[logs.length-1].topics[2].slice(26), liquidity: p.liquidity };
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

  const pc = Object.keys(ownerLiq).length;
  const tl = Object.values(ownerLiq).reduce((s, v) => s + v, 0n);
  console.log(`  Providers: ${pc}, total liq: ${tl}`);

  if (pc < 2 || tl === 0n) {
    console.log(`  >> Not enough data`);
    return;
  }

  const hhi = Object.values(ownerLiq).reduce((s, liq) => {
    const share = Number(liq * 10000n / tl) / 100;
    return s + share * share;
  }, 0);

  let penalty = 0;
  if (hhi > 2500) penalty = -Math.min(Math.round((hhi - 2500) / 150), 50);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULT: ${tokenName}`);
  console.log(`  HHI: ${Math.round(hhi)}`);
  console.log(`  Providers: ${pc}`);
  console.log(`  Penalty: ${penalty}`);

  const sorted = Object.entries(ownerLiq).sort((a, b) => Number(b[1] - a[1]));
  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const [addr, liq] = sorted[i];
    const pct = Number(liq * 10000n / tl) / 100;
    console.log(`  ${i+1}. ${addr} — ${pct.toFixed(1)}%`);
  }
  console.log(`${'='.repeat(70)}`);
}

async function main() {
  // HOOD (V3 pool)
  await computeHHIPenalty(
    '0xad648E8bA839798B65784379BdD760D443766cDB'.toLowerCase(),
    'HOOD/WETH V3',
    'HOOD ($947K TVL)'
  );
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
