import 'dotenv/config';
import { Contract, id as topicId } from 'ethers';
import { makeProvider } from './provider.js';

const V3_NFPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3';
const POOL_B = '0xd42a491087a15e5afd51feb3606066cc152d2b09';
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4'.toLowerCase();
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'.toLowerCase();
const FEE = 3000;
const POOL_MINT_SIG = topicId('Mint(address,address,int24,int24,uint128,uint256,uint256)');
const INC_LIQ_SIG = topicId('IncreaseLiquidity(uint256,uint128,uint256,uint256)');

async function main() {
  const provider = await makeProvider('SCREENER_RPC_URL');
  const head = await provider.getBlockNumber();
  const nfpm = new Contract(V3_NFPM, [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
  ], provider);

  // Get ALL Pool B mint txs, take the LAST 20 unique txs
  const step = 500_000;
  const allTxs = [];
  for (let s = 0; s <= head; s += step) {
    const e = Math.min(s + step - 1, head);
    try {
      const logs = await Promise.race([
        provider.getLogs({ address: POOL_B, topics: [POOL_MINT_SIG], fromBlock: s, toBlock: e }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 20000))
      ]);
      for (const lg of logs) {
        if (!allTxs.includes(lg.transactionHash)) allTxs.push(lg.transactionHash);
      }
    } catch (err) {
      console.log(`  chunk: ${err.shortMessage || err.message}`);
    }
  }
  console.log(`Total txs: ${allTxs.length}`);

  // SAME APPROACH AS computeHHIPenalty: batch 50 receipts
  const lastTxs = allTxs.slice(-20);
  const poolTokenIds = [];

  for (let i = 0; i < lastTxs.length; i += 50) {
    const batch = lastTxs.slice(i, i + 50);
    const receipts = await Promise.allSettled(
      batch.map(txHash =>
        Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 10000))
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

  console.log(`TokenIds from batch approach: ${poolTokenIds.length}`);

  // Now call positions() for each
  for (let i = 0; i < poolTokenIds.length; i += 100) {
    const batch = poolTokenIds.slice(i, i + 100);
    const results = await Promise.allSettled(
      batch.map(p =>
        Promise.race([
          nfpm.positions(p.tokenId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 5000))
        ]).then(pos => ({ ...p, liquidity: pos[7] })).catch(() => ({ ...p, liquidity: 0n }))
      )
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        poolTokenIds[i + j].liquidity = results[j].value.liquidity;
      }
    }
  }

  const active = poolTokenIds.filter(p => p.liquidity > 0n);
  console.log(`\nActive: ${active.length}/${poolTokenIds.length}`);
  console.log(`\nFirst 5 tokenIds with details:`);
  for (let k = 0; k < Math.min(5, poolTokenIds.length); k++) {
    const p = poolTokenIds[k];
    // Manually verify by calling positions again
    try {
      const pos = await nfpm.positions(p.tokenId);
      const t0 = pos[2].toLowerCase();
      const t1 = pos[3].toLowerCase();
      const fee = Number(pos[4]);
      const liq = pos[7];
      const isPB = (t0 === CASHCAT && t1 === WETH && fee === FEE) || (t0 === WETH && t1 === CASHCAT && fee === FEE);
      console.log(`  #${p.tokenId}: cachedLiq=${p.liquidity} actualLiq=${liq} match=${isPB}`);
    } catch (e) {
      console.log(`  #${p.tokenId}: ERROR ${e.message}`);
    }
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
