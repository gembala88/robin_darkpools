import 'dotenv/config';
import { formatUnits } from 'ethers';
import { makeProvider } from './provider.js';
import { LP_V4_CASHCAT_USDG } from './config.js';
import { depositV4 } from './lp_deposit.js';
import { UC } from './config.js';

async function main() {
  const provider = await makeProvider('LP_SCREENER_RPC_URL');
  const config = UC('lp');

  console.log('=== Test V4 Generic Deposit (DRY) ===\n');

  // Build poolInfo CASHCAT/USDG via PATH GENERIK (poolInfo param, not default)
  const poolInfo = {
    currency0: LP_V4_CASHCAT_USDG.key.currency0, // CASHCAT
    currency1: LP_V4_CASHCAT_USDG.key.currency1, // USDG
    fee: LP_V4_CASHCAT_USDG.key.fee,             // 2690
    tickSpacing: LP_V4_CASHCAT_USDG.key.tickSpacing, // 54
    hooks: LP_V4_CASHCAT_USDG.key.hooks,
    decimals0: 18,
    decimals1: 6,
    baseToken: { symbol: 'CASHCAT', address: LP_V4_CASHCAT_USDG.key.currency0 },
    quoteToken: { symbol: 'USDG', address: LP_V4_CASHCAT_USDG.key.currency1 },
  };

  console.log(`Pool: CASHCAT/USDG (V4)`);
  console.log(`Fee: ${poolInfo.fee} (${(poolInfo.fee / 10000).toFixed(2)}%)`);
  console.log(`Tick spacing: ${poolInfo.tickSpacing}`);
  console.log(`Hooks: ${poolInfo.hooks}`);
  console.log(`Mode: DRY (wallet=null) — simulating depositV4 via generic path\n`);

  // depositV4 with poolInfo parameter = generic path
  const result = await depositV4(provider, null, config, poolInfo);

  console.log(`\n=== DRY-RUN Result ===`);
  if (result) {
    console.log(`Entry tick: ${result.entryTick}`);
    console.log(`Tick range: ${result.tickLower} → ${result.tickUpper}`);
    console.log(`Liquidity: ${result.liquidity}`);
    console.log(`Pool key: ${JSON.stringify(result.key, null, 2)}`);
    console.log(`Actions: ${JSON.stringify(result.actions)}`);
    console.log(`\n✅ depositV4 via generic path berhasil (DRY).`);
  } else {
    console.log(`\n❌ depositV4 returned null`);
  }
}

main().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
