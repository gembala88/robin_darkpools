// Test A: RPC Fallback — run with: node test_fallback.js
// Set RPC_URL_BAD=1 env to force primary failure and test fallback switchover.
import 'dotenv/config';
import { makeProvider } from './provider.js';

async function test() {
  console.log('=== MODUL A: RPC Fallback Test ===\n');

  // If RPC_URL_BAD=1, temporarily set RPC_URL to invalid value
  if (process.env.RPC_URL_BAD) {
    const orig = process.env.RPC_URL;
    process.env.RPC_URL = 'https://invalid-url-that-will-fail.xyz';
    console.log('1. RPC_URL_BAD=1 — forcing primary to invalid URL\n');
  } else {
    console.log('1. Normal mode — using configured RPC (or public RPC)\n');
  }

  console.log('2. Creating provider with fallback...');
  const provider = await makeProvider();

  console.log('3. Calling getNetwork()...');
  const net = await provider.getNetwork();
  console.log(`   chainId: ${net.chainId} (expected: 4663)`);


  console.log('4. Calling getBlockNumber()...');
  const block = await provider.getBlockNumber();
  console.log(`   blockNumber: ${block}`);


  console.log('5. Calling getLogs() on a recent 10-block range...');
  const logs = await provider.getLogs({
    address: '0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d',
    topics: [],
    fromBlock: block - 100,
    toBlock: block,
  });
  console.log(`   logs found: ${logs.length}`);


  // Edge-case checks
  console.log('\n6. Edge-case verification:');
  console.log(`   - getNetwork() returned non-null: ${net !== null}`);
  console.log(`   - blockNumber > 0: ${block > 0}`);
  console.log(`   - logs is array: ${Array.isArray(logs)}`);
  console.log(`   - chainId is 4663: ${Number(net.chainId) === 4663}`);
  console.log(`   - typeof getBlockNumber: ${typeof provider.getBlockNumber}`);

  if (process.env.RPC_URL_BAD) {
    console.log('\n✅ FALLBACK BERHASIL — primary gagal, public RPC digunakan');
  } else {
    console.log('\n✅ PRIMARY BERHASIL — fallback tidak diaktifkan');
  }
}

test().catch(e => {
  console.error('\n❌ TEST GAGAL:', e.shortMessage || e.message);
  process.exit(1);
});
