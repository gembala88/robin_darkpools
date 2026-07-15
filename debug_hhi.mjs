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

  // Get ALL Pool B mint txs, take the LAST 10 unique txs
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
      console.log(`  chunk ${s}-${e}: ${err.shortMessage || err.message}`);
    }
  }
  console.log(`Total unique Pool B txs: ${allTxs.length}`);

  // Take the last 10 txs
  const lastTxs = allTxs.slice(-10);
  console.log(`\nChecking last ${lastTxs.length} txs:\n`);

  for (let i = 0; i < lastTxs.length; i++) {
    const txHash = lastTxs[i];
    try {
      const receipt = await Promise.race([
        provider.getTransactionReceipt(txHash),
        new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 10000))
      ]);
      if (!receipt) { console.log(`  [${i}] tx null`); continue; }

      // Find NFPM events in this receipt
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== V3_NFPM.toLowerCase()) continue;
        if (log.topics[0] !== INC_LIQ_SIG) continue;
        const tokenId = BigInt(log.topics[1]);

        // Call positions()
        let pos;
        try {
          pos = await Promise.race([
            nfpm.positions(tokenId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 5000))
          ]);
        } catch {
          console.log(`  [${i}] #${tokenId}: positions() timeout`);
          break;
        }

        const t0 = pos[2].toLowerCase();
        const t1 = pos[3].toLowerCase();
        const fee = Number(pos[4]);
        const liq = pos[7];
        const tl = Number(pos[5]);
        const tu = Number(pos[6]);
        const order = t0 === CASHCAT && t1 === WETH ? 'correct' : t0 === WETH && t1 === CASHCAT ? 'SWAPPED' : 'WRONG';
        const isPoolB = (t0 === CASHCAT && t1 === WETH && fee === FEE) || (t0 === WETH && t1 === CASHCAT && fee === FEE);
        const poolLabel = isPoolB ? '★ POOL_B' : `${t0.slice(0,6)}/${t1.slice(0,6)} ${fee/10000}%`;
        console.log(`  [${i}] #${tokenId}: liq=${liq} order=${order} ${poolLabel} tick=[${tl},${tu}]`);
        break; // one event per tx
      }
    } catch (err) {
      console.log(`  [${i}]: ${err.shortMessage || err.message}`);
    }
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
