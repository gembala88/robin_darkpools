import 'dotenv/config';
import { Contract, formatEther, toBeHex } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, LP_V3_CASHCAT_WETH } from './config.js';

async function main() {
  const provider = await makeProvider();

  // 1. Check router basic functions
  const router = new Contract(V3.swapRouter02, [
    'function WETH9() view returns (address)',
    'function factory() view returns (address)',
  ], provider);

  console.log('=== Router ===');
  const [rWeth, rFactory] = await Promise.all([
    router.WETH9().catch(e => { console.error('  WETH9() failed:', e.shortMessage); return null; }),
    router.factory().catch(e => { console.error('  factory() failed:', e.shortMessage); return null; }),
  ]);
  if (rWeth) console.log(`WETH9(): ${rWeth} (config: ${LP_V3_CASHCAT_WETH.token1})`);
  if (rFactory) console.log(`factory(): ${rFactory} (config: ${V3.factory})`);

  // 2. Check via factory if pool exists
  if (rFactory) {
    const factory = new Contract(rFactory, [
      'function getPool(address,address,uint24) view returns (address)',
      'function feeAmountTickSpacing(uint24) view returns (int24)',
    ], provider);

    const poolAddr = await factory.getPool(LP_V3_CASHCAT_WETH.token0, LP_V3_CASHCAT_WETH.token1, LP_V3_CASHCAT_WETH.fee);
    console.log(`\n=== Factory getPool(CASHCAT, WETH, 10000) ===`);
    console.log(`Pool: ${poolAddr} (config: ${LP_V3_CASHCAT_WETH.pool})`);
    if (poolAddr.toLowerCase() === LP_V3_CASHCAT_WETH.pool.toLowerCase()) {
      console.log('✅ Pool address matches config');
    } else {
      console.log('❌ Pool address MISMATCH!');
    }

    // Also try other fee tiers
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const p = await factory.getPool(LP_V3_CASHCAT_WETH.token0, LP_V3_CASHCAT_WETH.token1, fee);
        if (p !== '0x0000000000000000000000000000000000000000') {
          console.log(`  Pool exists at fee ${fee}: ${p}`);
        }
      } catch {}
    }
  }

  // 3. Query pool directly with raw RPC to see what code is there
  console.log(`\n=== Pool ${LP_V3_CASHCAT_WETH.pool} ===`);
  const code = await provider.getCode(LP_V3_CASHCAT_WETH.pool);
  console.log(`Has code: ${code !== '0x'}, length: ${code ? (code.length - 2) / 2 : 0} bytes`);

  // 4. Check our balances
  console.log(`\n=== Wallet ${process.env.WALLET || '(from env)'} ===`);
  const walletAddr = process.env.WALLET || '0xA4E6738d5C6fF9a58aA19F0258Ec561F3654Ba56';
  const balEth = await provider.getBalance(walletAddr);
  console.log(`ETH: ${formatEther(balEth)}`);

  const erc20 = new Contract(LP_V3_CASHCAT_WETH.token1, [
    'function balanceOf(address) view returns (uint256)',
    'function symbol() view returns (string)',
  ], provider);
  const wethBal = await erc20.balanceOf(walletAddr);
  const wethSym = await erc20.symbol().catch(() => '?');
  console.log(`${wethSym} (${LP_V3_CASHCAT_WETH.token1}): ${formatEther(wethBal)}`);
}

main().catch(e => console.error('FAILED:', e.shortMessage || e.message));
