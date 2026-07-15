// find_arb_tokens.mjs — find tokens with BOTH active RobinFun curve + V4 liquidity
// Run on VPS: node find_arb_tokens.mjs

import 'dotenv/config';
import { JsonRpcProvider, getAddress, formatEther, AbiCoder, id } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com');
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

const initTopic = id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const liqSig = id('getLiquidity(bytes32)').slice(0, 10);
const s0Sig = id('getSlot0(bytes32)').slice(0, 10);

// RobinFun curve interface
const CURVE_ABI = ['function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)'];

async function main() {
  const head = await provider.getBlockNumber();
  console.log('Chain head:', head);
  console.log('Scanning all Initialize events from PoolManager...');

  // Scan in chunks, batch by block range
  const BATCH = 50000;
  const found = new Map(); // poolId -> {c0, c1, fee, ts, hooks}

  for (let start = 0; start <= head; start += BATCH) {
    const end = Math.min(start + BATCH - 1, head);
    try {
      const logs = await provider.getLogs({ address: PM, topics: [initTopic], fromBlock: start, toBlock: end });
      for (const lg of logs) {
        const poolId = lg.topics[1];
        const c0 = getAddress('0x' + lg.topics[2].slice(26));
        const c1 = getAddress('0x' + lg.topics[3].slice(26));
        found.set(poolId, { c0, c1 });
      }
      if (logs.length > 0) {
        console.log(`  blocks ${start}-${end}: ${logs.length} pools found (total: ${found.size})`);
      }
    } catch (err) {
      console.log(`  blocks ${start}-${end}: ERROR ${err.shortMessage?.slice(0, 60) || err.message?.slice(0, 60)}`);
    }
  }

  console.log(`\nTotal pools found: ${found.size}`);

  // For each unique token pair, check if token has a curve + V4 liquidity > 0
  const tokensWithLiquidity = new Map();
  const checkedTokens = new Set();

  for (const [poolId, { c0, c1 }] of found) {
    // Find the non-native token
    const tokenAddr = c0 === '0x0000000000000000000000000000000000000000' ? c1 : c1 === '0x0000000000000000000000000000000000000000' ? c0 : null;
    if (!tokenAddr) continue;

    const key = tokenAddr.toLowerCase();
    if (checkedTokens.has(key)) continue;
    checkedTokens.add(key);

    // Check V4 liquidity via StateView
    try {
      const r = await provider.call({ to: SV, data: liqSig + coder.encode(['bytes32'], [poolId]).slice(2) });
      const [liquidity] = coder.decode(['uint128'], r);
      if (liquidity === 0n) continue;

      // Check curve
      const CURVE_FACTORIES = ['0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d', '0x42B1f2Fb09502b66Ae21769b3384a7788d020d73'];
      for (const factory of CURVE_FACTORIES) {
        try {
          const curve = new Contract(factory, CURVE_ABI, provider);
          const d = await curve.curves(tokenAddr);
          if (d.raiseTarget > 0n && d.realEth > 0n) {
            tokensWithLiquidity.set(key, {
              token: tokenAddr,
              poolId,
              liquidity: liquidity.toString(),
              realEth: d.realEth.toString(),
              raiseTarget: d.raiseTarget.toString(),
              gradPct: Number(d.realEth * 10000n / d.raiseTarget) / 100,
            });
            console.log(`\n✅ ${tokenAddr} — liq=${formatEther(liquidity)} V4, curve=${formatEther(d.realEth)}/${formatEther(d.raiseTarget)} ETH (${tokensWithLiquidity.get(key).gradPct}%)`);
            break;
          }
        } catch { /* no curve at this factory */ }
      }
    } catch { /* skip */ }
  }

  console.log(`\n\n=== RESULTS: ${tokensWithLiquidity.size} tokens with BOTH curve + V4 liquidity ===`);
  for (const [key, info] of tokensWithLiquidity) {
    console.log(`${info.token} V4liq=${formatEther(info.liquidity)} curve=${formatEther(info.realEth)}/${formatEther(info.raiseTarget)} ETH (${info.gradPct}%)`);
  }
}

main().catch(console.error);
