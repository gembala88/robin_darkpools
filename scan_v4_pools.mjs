import 'dotenv/config';
import fs from 'node:fs';
import { Contract, AbiCoder, keccak256, getAddress } from 'ethers';
import { makeProvider } from './provider.js';
import { V4 } from './config.js';

const STATE_VIEW = V4.stateView;
const BATCH = 25;
const TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const FEE_TIERS = [
  { fee: 250000, tickSpacing: 5000, label: '25%' },
  { fee: 100000, tickSpacing: 2000, label: '10%' },
];

function computePoolId(token, fee, tickSpacing) {
  const coder = AbiCoder.defaultAbiCoder();
  const tok = getAddress(token.toLowerCase());
  const zero = '0x0000000000000000000000000000000000000000';
  return keccak256(coder.encode(
    ['(address,address,uint24,int24,address)'],
    [[zero, tok, fee, tickSpacing, zero]]
  ));
}

async function checkPool(stateView, poolId) {
  const [sqrtPriceX96] = await Promise.race([
    stateView.getSlot0.staticCall(poolId),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
  ]);
  if (sqrtPriceX96 > 0n) return { status: 'active', sqrt: sqrtPriceX96.toString() };
  return { status: 'inactive' };
}

async function main() {
  const provider = await makeProvider();
  const raw = fs.readFileSync('screener_state.json', 'utf8');
  const state = JSON.parse(raw);
  const tokens = Object.values(state.tokens || {}).filter(t => t.active);
  console.log(`Loaded ${tokens.length} active curve tokens from screener_state.json`);

  const checks = [];
  for (const t of tokens) {
    const addr = getAddress(t.token.toLowerCase());
    for (const ft of FEE_TIERS) {
      checks.push({
        token: addr,
        symbol: t.symbol,
        fee: ft.fee,
        tickSpacing: ft.tickSpacing,
        label: ft.label,
        poolId: computePoolId(addr, ft.fee, ft.tickSpacing),
        result: null,
      });
    }
  }
  console.log(`Total pool checks: ${checks.length} (${tokens.length} tokens x ${FEE_TIERS.length} fee tiers)`);
  console.log(`Batch size: ${BATCH}, timeout: ${TIMEOUT_MS}ms, max retries: ${MAX_RETRIES}`);
  console.log('');

  const stateView = new Contract(STATE_VIEW, [
    'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ], provider);

  const start = Date.now();

  async function runPass(poolEntries) {
    const results = [];
    for (let i = 0; i < poolEntries.length; i += BATCH) {
      const batch = poolEntries.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(c =>
          checkPool(stateView, c.poolId)
            .then(r => ({ ...c, result: r }))
            .catch(err => ({ ...c, result: { status: 'failed', error: err.shortMessage || err.message } }))
        )
      );
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        const val = r.status === 'fulfilled' ? r.value : { ...batch[j], result: { status: 'failed', error: 'unhandled rejection' } };
        results.push(val);
      }
    }
    return results;
  }

  const pass1 = await runPass(checks, 1);
  const failed = pass1.filter(c => c.result.status === 'failed');
  const active = pass1.filter(c => c.result.status === 'active');

  let retriesUsed = 0;
  let failureResolved = [];
  let currentFailed = failed;

  for (let attempt = 2; attempt <= MAX_RETRIES && currentFailed.length > 0; attempt++) {
    console.log(`\n  Retry pass ${attempt}/${MAX_RETRIES} for ${currentFailed.length} failed checks...`);
    const retryResults = await runPass(currentFailed, attempt);
    const stillFailed = retryResults.filter(c => c.result.status === 'failed');
    const newlyActive = retryResults.filter(c => c.result.status === 'active');
    active.push(...newlyActive);
    failureResolved.push(...retryResults.filter(c => c.result.status !== 'failed'));
    retriesUsed++;
    console.log(`  -> ${newlyActive.length} newly active, ${stillFailed.length} still failed`);
    currentFailed = stillFailed;
  }

  const finalFailed = currentFailed;
  const finalInactive = pass1.filter(c => c.result.status === 'inactive')
    .concat(failureResolved.filter(c => c.result.status === 'inactive'));

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  console.log('');
  console.log(`=== RESULTS (${elapsed}s) ===`);
  console.log(`  Active pools:    ${active.length}`);
  console.log(`  Confirmed empty: ${finalInactive.length}`);
  if (finalFailed.length > 0) {
    console.log(`  FAILED (no retry): ${finalFailed.length}`);
    for (const c of finalFailed.slice(0, 10)) {
      console.log(`    ${c.symbol} ${c.label} — ${c.result.error}`);
    }
    if (finalFailed.length > 10) console.log(`    ... and ${finalFailed.length - 10} more`);
  } else {
    console.log('  FAILED:          0 — semua pool berhasil dicek!');
  }
  console.log(`  Retry passes:    ${retriesUsed}`);

  const byToken = {};
  for (const p of active) {
    const key = p.token.toLowerCase();
    if (!byToken[key]) byToken[key] = { token: p.token, symbol: p.symbol, pools: [] };
    byToken[key].pools.push({
      id: p.poolId,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      label: p.label,
      key: {
        currency0: '0x0000000000000000000000000000000000000000',
        currency1: getAddress(p.token),
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hooks: '0x0000000000000000000000000000000000000000',
      },
    });
  }

  const output = {
    scannedAt: Date.now(),
    elapsed,
    totalTokens: tokens.length,
    totalChecked: checks.length,
    activeTokens: Object.keys(byToken).length,
    activePools: active.length,
    confirmedEmpty: finalInactive.length,
    failedChecks: finalFailed.map(c => ({ symbol: c.symbol, fee: c.fee, label: c.label, error: c.result.error })),
    retryPasses: retriesUsed,
    tokens: Object.values(byToken),
  };

  fs.writeFileSync('curve_v4_pools.json', JSON.stringify(output, null, 2));
  console.log('  Written to: curve_v4_pools.json');

  if (finalFailed.length > 0) {
    console.log(`\n  WARNING: ${finalFailed.length} pools gagal dicek setelah ${MAX_RETRIES}x percobaan.`);
    console.log('  Jalankan ulang scan untuk coba lagi, atau cek RPC.');
  }

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
