// scan_v4_pools.mjs — One-time retroactive scan: check which curve tokens from
// screener_state.json have active native-ETH V4 pools at standard fee tiers.
//
// Uses StateView.getSlot0() — lightweight view call per pool (sqrtPrice != 0 = active).
// Batch concurrent, timeout-guarded, progress-logged.
//
// Output: curve_v4_pools.json — read by arb.js at startup.
//
//   node scan_v4_pools.mjs

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, AbiCoder, keccak256, getAddress } from 'ethers';
import { makeProvider } from './provider.js';
import { V4 } from './config.js';

const STATE_VIEW = V4.stateView;
const BATCH = 25;
const TIMEOUT_MS = 10000;
const FEE_TIERS = [
  { fee: 250000, tickSpacing: 5000, label: '25%' },
  { fee: 100000, tickSpacing: 2000, label: '10%' },
];

// compute V4 poolId = keccak256(abi.encode(PoolKey))
function computePoolId(token, fee, tickSpacing) {
  const coder = AbiCoder.defaultAbiCoder();
  const tok = getAddress(token.toLowerCase());
  const zero = '0x0000000000000000000000000000000000000000';
  return keccak256(coder.encode(
    ['(address,address,uint24,int24,address)'],
    [[zero, tok, fee, tickSpacing, zero]]
  ));
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
      });
    }
  }
  console.log(`Total pool checks: ${checks.length} (${tokens.length} tokens x ${FEE_TIERS.length} fee tiers)`);
  console.log(`Batch size: ${BATCH}, timeout: ${TIMEOUT_MS}ms`);
  console.log('');

  const start = Date.now();
  const active = [];

  // Use ethers Contract (not raw selector) — same pattern as lp_deposit.js getV4Slot0()
  const stateView = new Contract(STATE_VIEW, [
    'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ], provider);

  for (let i = 0; i < checks.length; i += BATCH) {
    const batch = checks.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(c =>
        Promise.race([
          stateView.getSlot0.staticCall(c.poolId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
        ]).then(([sqrtPriceX96]) => sqrtPriceX96 > 0n ? { ...c, sqrtPriceX96: sqrtPriceX96.toString() } : null
        ).catch(() => null))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) active.push(r.value);
    }

    if ((i + BATCH) % 100 < BATCH || i + BATCH >= checks.length) {
      const pct = Math.min(100, ((i + BATCH) / checks.length * 100).toFixed(1));
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  ${Math.min(i + BATCH, checks.length)}/${checks.length} (${pct}%) — ${active.length} active pools found — ${elapsed}s elapsed`);
    }
  }

  // Group by token
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
    totalTokens: tokens.length,
    totalChecked: checks.length,
    activeTokens: Object.keys(byToken).length,
    activePools: active.length,
    tokens: Object.values(byToken),
  };

  fs.writeFileSync('curve_v4_pools.json', JSON.stringify(output, null, 2));
  console.log('');
  console.log(`=== RESULTS ===`);
  console.log(`  Tokens with active V4 pools: ${output.activeTokens}/${tokens.length}`);
  console.log(`  Total active pools: ${output.activePools}`);
  console.log(`  Elapsed: ${((Date.now() - start) / 1000).toFixed(0)}s`);
  console.log('  Written to: curve_v4_pools.json');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
