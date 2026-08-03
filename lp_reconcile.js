// lp_reconcile.js — on-chain state reconciliation for the LP monitor.
// Scans the wallet's V3 NFPM positions (tokenOfOwnerByIndex), keeps every position
// with liquidity > 0, and merges any LIVE position that is MISSING from
// lp_state.json back into it. Conservative: never removes existing entries.
//
// Usage:
//   node lp_reconcile.js                 # read-only scan + report
//   node lp_reconcile.js --write         # also write missing positions to lp_state.json
//   WALLET=0x... node lp_reconcile.js    # scan a specific wallet (no PRIVATE_KEY needed)
//
// Requires RPC access (provider.js fallback logic works automatically).

import fs from 'node:fs';
import { Contract, Wallet, AbiCoder } from 'ethers';
import { V3 } from './config.js';
import { V3_NFPM_ABI, ERC20_ABI } from './abis.js';
import { makeProvider } from './provider.js';

const STATE_FILE = new URL('./lp_state.json', import.meta.url);
const WRITE = process.argv.includes('--write');

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
  try {
    const pool = await getV3PoolAddress(provider, token0, token1, fee);
    const slot0Raw = await provider.call({ to: pool, data: '0x3850c7bd' });
    const decoded = AbiCoder.defaultAbiCoder().decode(
      ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'], slot0Raw
    );
    currentTick = Number(decoded[1]);
  } catch {}

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
    // entryValueUsd: null → monitor will not arm the USD trailing take-profit for
    // this recovered position (we don't know its original entry value). The IL
    // stop-loss and out-of-range monitoring still work normally.
    entryValueUsd: null,
    block: 0,
    tx: '',
    ts: Date.now(),
    liquidityRecovered: liquidity.toString(),
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

  let owner = process.env.WALLET;
  if (!owner) {
    if (!process.env.PRIVATE_KEY) throw new Error('Set WALLET=0x... or PRIVATE_KEY=0x...');
    owner = new Wallet(process.env.PRIVATE_KEY).address;
  }
  console.log(`Wallet: ${owner}`);

  const ids = await listOwnedV3TokenIds(provider, owner);
  console.log(`Owned V3 NFT positions: ${ids.length}`);

  const state = loadState();
  const existing = new Set(state.positions.map(p => `${p.dex}:${p.tokenId}`));

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
  for (const { id, pos } of live) {
    if (existing.has(`V3:${id}`)) {
      console.log(`  #${id}: already tracked`);
    } else {
      console.log(`  #${id}: MISSING from state — will ${WRITE ? 'ADD' : '(add with --write)'}`);
      missing.push({ id, pos });
    }
  }

  if (WRITE && missing.length > 0) {
    for (const { id, pos } of missing) {
      const entry = await buildEntry(provider, id, pos);
      state.positions.push(entry);
      console.log(`  ✅ Added #${id} (${entry.pool}) to lp_state.json`);
    }
    saveState(state);
    console.log(`\nSaved ${state.positions.length} total positions to lp_state.json`);
  } else if (missing.length > 0) {
    console.log('\nRun with --write to persist the missing positions.');
  } else {
    console.log('\nState is in sync with on-chain positions.');
  }
}

main().catch((e) => { console.error(`ERROR: ${e.shortMessage || e.message}`); process.exit(1); });
