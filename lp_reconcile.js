// lp_reconcile.js — on-chain state reconciliation for the LP monitor.
// Scans the wallet's V3 NFPM positions (tokenOfOwnerByIndex), keeps every position
// with liquidity > 0, and merges any LIVE position that is MISSING from
// lp_state.json back into it. Conservative: never removes existing entries.
//
// For recovered positions (and existing ones with entryValueUsd == null) it
// estimates entryValueUsd using the CURRENT price as the entry proxy, since the
// original entry price is unknown. TP then baselines from now (0%) — an estimate,
// better than no TP at all.
//
// Usage:
//   node lp_reconcile.js                 # read-only scan + report
//   node lp_reconcile.js --write         # also write missing positions + backfill null entryValueUsd
//   node lp_reconcile.js --write --force # force-recompute entryValueUsd even if already set
//   WALLET=0x... node lp_reconcile.js    # scan a specific wallet (no PRIVATE_KEY needed)
//   TOKEN_IDS=541813,550609 node lp_reconcile.js --write   # reconcile specific token IDs (no wallet needed)
//
// Requires RPC access (provider.js fallback logic works automatically).

import fs from 'node:fs';
import { Contract, Wallet, AbiCoder } from 'ethers';
import { V3 } from './config.js';
import { V3_NFPM_ABI, ERC20_ABI } from './abis.js';
import { makeProvider } from './provider.js';
import { computePositionUsdValue } from './lp_monitor.js';
import { getEthUsdPrice } from './v3_math.js';

const STATE_FILE = new URL('./lp_state.json', import.meta.url);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const TOKEN_IDS = (process.env.TOKEN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [], monitor: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Balance-based position enumeration (read-only, no wallet provider needed).
async function listOwnedV3TokenIds(provider, owner) {
  const nfpm = new Contract(V3.nfpm, [
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  ], provider);
  const balance = Number(await nfpm.balanceOf(owner));
  const ids = [];
  for (let i = 0; i < balance; i++) {
    ids.push(BigInt(await nfpm.tokenOfOwnerByIndex(owner, i)).toString());
  }
  return ids;
}

function erc20Proxy(provider, addr) {
  return new Contract(addr, ERC20_ABI, provider);
}

async function buildEntry(provider, tokenId, pos) {
  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  let sym0 = '?', sym1 = '?';
  try {
    const c0 = erc20Proxy(provider, token0);
    sym0 = await c0.symbol().catch(() => '?');
    sym1 = await erc20Proxy(provider, token1).symbol().catch(() => '?');
  } catch {}

  // Amounts are not recoverable from positions() (only liquidity is). Use a
  // reasonable non-zero placeholder derived from liquidity so the entry stays
  // self-consistent for the monitor; the monitor recomputes USD value live.
  const liquidity = pos.liquidity;

  // entryTick: approximate with current pool tick so IL starts ~0 and drifts
  // with the market from here on (position was created at an unknown earlier tick).
  let currentTick = tickLower;
  let sqrtPriceX96 = 0;
  try {
    const pool = await getV3PoolAddress(provider, token0, token1, fee);
    const slot0Raw = await provider.call({ to: pool, data: '0x3850c7bd' });
    const decoded = AbiCoder.defaultAbiCoder().decode(
      ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'], slot0Raw
    );
    sqrtPriceX96 = Number(decoded[0]);
    currentTick = Number(decoded[1]);
  } catch {}

  // Estimated entry value: CURRENT price as entry proxy (original entry unknown).
  // Reuses the monitor's computePositionUsdValue. Baseline for USD take-profit.
  let entryValueUsd = null;
  if (sqrtPriceX96 > 0) {
    entryValueUsd = await computePositionUsdValue(
      provider, liquidity, sqrtPriceX96, tickLower, tickUpper, currentTick,
      pos.tokensOwed0, pos.tokensOwed1, token0, token1
    ).catch(() => null);
  }

  const entry = {
    dex: 'V3',
    pool: `${sym0}/${sym1}`,
    tokenId,
    token0,
    token1,
    fee,
    entryTick: currentTick,
    tickLower,
    tickUpper,
    amount0: '0',
    amount1: '0',
    // entryValueUsd: ESTIMATE using current price as the entry proxy. The USD
    // trailing take-profit baselines from now (0%). Not the original entry value
    // (unknown), but better than no TP at all. IL stop-loss is unaffected.
    entryValueUsd,
    block: 0,
    tx: '',
    ts: Date.now(),
    liquidityRecovered: liquidity.toString(),
    entryValueEstimated: entryValueUsd !== null,
  };

  return entry;
}

// Duplicate of the pool-address derivation used by the monitor (kept local to
// avoid pulling in monitor internals). Token order: contract stores token0 < token1.
async function getV3PoolAddress(provider, token0, token1, fee) {
  const factory = new Contract(V3.factory, ['function getPool(address,address,uint24) view returns (address)'], provider);
  const pool = await factory.getPool(token0, token1, fee);
  if (pool === '0x0000000000000000000000000000000000000000') {
    // Try reversed order (Uniswap canonical: token0 is lexicographically smaller).
    const pool2 = await factory.getPool(token1, token0, fee);
    if (pool2 === '0x0000000000000000000000000000000000000000') throw new Error('no pool');
    return pool2;
  }
  return pool;
}

async function main() {
  const provider = await makeProvider();

  // Warm the ETH/USD cache so computePositionUsdValue uses the LIVE price
  // instead of the 3000 fallback (CoinGecko only queried once on first call).
  await getEthUsdPrice();

  let ids;
  if (TOKEN_IDS.length > 0) {
    ids = TOKEN_IDS;
    console.log(`Scanning ${ids.length} specific token IDs (no wallet needed)`);
  } else {
    let owner = process.env.WALLET;
    if (!owner) {
      if (!process.env.PRIVATE_KEY) throw new Error('Set WALLET=0x... or PRIVATE_KEY=0x... (or TOKEN_IDS=...)');
      owner = new Wallet(process.env.PRIVATE_KEY).address;
    }
    console.log(`Wallet: ${owner}`);
    ids = await listOwnedV3TokenIds(provider, owner);
    console.log(`Owned V3 NFT positions: ${ids.length}`);
  }

  const state = loadState();
  const byKey = new Map(state.positions.map(p => [`${p.dex}:${p.tokenId}`, p]));

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, provider);
  const live = [];
  const closed = [];

  for (const id of ids) {
    try {
      const pos = await nfpm.positions.staticCall(id);
      if (pos.liquidity === 0n) {
        closed.push(id);
        console.log(`  #${id}: liquidity=0 (closed/collected) — skip`);
        continue;
      }
      live.push({ id, pos });
      console.log(`  #${id}: liquidity=${pos.liquidity.toString().slice(0, 10)}… live`);
    } catch (e) {
      console.log(`  #${id}: read failed — ${(e?.shortMessage || e?.message).slice(0, 60)}`);
    }
  }

  console.log(`\nLive: ${live.length} | Closed/skip: ${closed.length}`);

  const missing = [];
  const needsBackfill = [];
  for (const { id, pos } of live) {
    const existing = byKey.get(`V3:${id}`);
    if (existing) {
      if (FORCE || existing.entryValueUsd == null || existing.entryValueUsd === 0) {
        console.log(`  #${id}: tracked but entryValueUsd needs recompute${FORCE ? ' (--force)' : ''} — will ${WRITE ? 'BACKFILL estimate' : '(backfill with --write)'}`);
        needsBackfill.push({ id, pos, existing });
      } else {
        console.log(`  #${id}: already tracked (entryValueUsd=$${Number(existing.entryValueUsd).toFixed(2)})`);
      }
    } else {
      console.log(`  #${id}: MISSING from state — will ${WRITE ? 'ADD' : '(add with --write)'}`);
      missing.push({ id, pos });
    }
  }

  if (WRITE) {
    for (const { id, pos } of missing) {
      const entry = await buildEntry(provider, id, pos);
      state.positions.push(entry);
      console.log(`  ✅ Added #${id} (${entry.pool}) — entryValueUsd=$${entry.entryValueUsd?.toFixed(2) ?? '?'} (${entry.entryValueEstimated ? 'est.' : 'n/a'})`);
    }
    for (const { id, pos, existing } of needsBackfill) {
      const entry = await buildEntry(provider, id, pos);
      existing.entryValueUsd = entry.entryValueUsd;
      existing.entryValueEstimated = entry.entryValueEstimated;
      console.log(`  ✅ Backfilled #${id} (${entry.pool}) — entryValueUsd=$${entry.entryValueUsd?.toFixed(2) ?? '?'} (${entry.entryValueEstimated ? 'est.' : 'n/a'})`);
    }
    if (missing.length > 0 || needsBackfill.length > 0) {
      saveState(state);
      console.log(`\nSaved ${state.positions.length} total positions to lp_state.json`);
    } else {
      console.log('\nNothing to change.');
    }
  } else if (missing.length > 0 || needsBackfill.length > 0) {
    console.log('\nRun with --write to persist the changes.');
  } else {
    console.log('\nState is in sync with on-chain positions.');
  }
}

main().catch((e) => { console.error(`ERROR: ${e.shortMessage || e.message}`); process.exit(1); });
