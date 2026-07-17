import 'dotenv/config';
import { ethers } from 'ethers';

const DRY = process.env.DRY !== '0'; // default TRUE (aman)
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SWAP_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';

const provider = new ethers.JsonRpcProvider(process.env.LP_RPC_URL || process.env.RPC_URL);
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const wethAbi = [...erc20Abi, 'function withdraw(uint256)'];
const routerAbi = ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'];
const quoterAbi = ['function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)'];

async function swapToken(wallet, token, fee, decimals, label) {
  const t = new ethers.Contract(token, erc20Abi, provider);
  const bal = await t.balanceOf(wallet ? wallet.address : '0x894669bDFF1B88Ed3Fb4D159A071D96D9681470F');
  console.log(`${label} balance:`, ethers.formatUnits(bal, decimals));
  if (bal === 0n) { console.log(`  Tidak ada ${label} untuk di-swap.`); return; }

  const quoter = new ethers.Contract(QUOTER, quoterAbi, provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall([token, WETH, bal, fee, 0]);
  const amountOutMin = amountOut - (amountOut * 100n) / 10000n;
  console.log(`  Quote ${label}->WETH:`, ethers.formatEther(amountOut), '| min:', ethers.formatEther(amountOutMin));

  if (DRY) { console.log(`  DRY-RUN: tidak ada tx dikirim untuk ${label}.`); return; }

  const tW = new ethers.Contract(token, erc20Abi, wallet);
  const allowance = await tW.allowance(wallet.address, SWAP_ROUTER);
  if (allowance < bal) {
    console.log(`  Approving ${label}...`);
    const tx = await tW.approve(SWAP_ROUTER, ethers.MaxUint256);
    await tx.wait();
    console.log('  Approve tx:', tx.hash);
  }
  const router = new ethers.Contract(SWAP_ROUTER, routerAbi, wallet);
  const params = [token, WETH, fee, wallet.address, bal, amountOutMin, 0];
  const tx = await router.exactInputSingle(params);
  console.log(`  Swap ${label} tx:`, tx.hash);
  const rc = await tx.wait();
  console.log(`  Status: ${rc.status === 1 ? '✅' : '❌'}`);
}

async function main() {
  const wallet = DRY ? null : new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const addr = wallet ? wallet.address : '0x894669bDFF1B88Ed3Fb4D159A071D96D9681470F';

  await swapToken(wallet, CASHCAT, 10000, 18, 'CASHCAT');
  await swapToken(wallet, USDG, 100, 6, 'USDG');

  if (DRY) { console.log('\nDRY-RUN selesai. Set DRY=0 untuk eksekusi.'); return; }

  const weth = new ethers.Contract(WETH, wethAbi, wallet);
  const wethBal = await weth.balanceOf(wallet.address);
  console.log('\nTotal WETH sekarang:', ethers.formatEther(wethBal));
  if (wethBal > 0n) {
    console.log('Unwrapping WETH -> ETH...');
    const tx = await weth.withdraw(wethBal);
    await tx.wait();
    console.log('Unwrap tx:', tx.hash);
  }
  const ethBal = await provider.getBalance(wallet.address);
  console.log('Final ETH balance:', ethers.formatEther(ethBal));
}
main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
