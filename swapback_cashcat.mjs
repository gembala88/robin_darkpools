import 'dotenv/config';
import { ethers } from 'ethers';

const DRY = process.env.DRY !== '0'; // default TRUE (aman)
const CASHCAT = '0x020bfC650A365f8BB26819deAAbF3E21291018b4';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const SWAP_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const wethAbi = [...erc20Abi, 'function withdraw(uint256)'];
const routerAbi = ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'];
const quoterAbi = ['function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)'];

async function main() {
  const wallet = DRY ? null : new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const addr = wallet ? wallet.address : '0x894669bDFF1B88Ed3Fb4D159A071D96D9681470F';
  const cashcat = new ethers.Contract(CASHCAT, erc20Abi, provider);
  const bal = await cashcat.balanceOf(addr);
  console.log('CASHCAT balance:', ethers.formatEther(bal));
  if (bal === 0n) { console.log('Tidak ada yang perlu di-swap.'); return; }

  const quoter = new ethers.Contract(QUOTER, quoterAbi, provider);
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall([CASHCAT, WETH, bal, 10000, 0]);
  const amountOutMin = amountOut - (amountOut * 100n) / 10000n; // 1% slippage
  console.log('Quote CASHCAT->WETH:', ethers.formatEther(amountOut), '| min:', ethers.formatEther(amountOutMin));

  if (DRY) { console.log('\nDRY-RUN: tidak ada tx dikirim. Set DRY=0 untuk eksekusi.'); return; }

  const cashcatW = new ethers.Contract(CASHCAT, erc20Abi, wallet);
  const allowance = await cashcatW.allowance(wallet.address, SWAP_ROUTER);
  if (allowance < bal) {
    console.log('Approving CASHCAT untuk SwapRouter...');
    const tx = await cashcatW.approve(SWAP_ROUTER, ethers.MaxUint256);
    await tx.wait();
    console.log('Approve tx:', tx.hash);
  }

  const router = new ethers.Contract(SWAP_ROUTER, routerAbi, wallet);
  const params = [CASHCAT, WETH, 10000, wallet.address, bal, amountOutMin, 0];
  const pop = await router.exactInputSingle.populateTransaction(params);
  const gas = await wallet.estimateGas(pop);
  console.log('Estimated gas:', gas.toString());
  const tx = await wallet.sendTransaction(pop);
  console.log('Swap tx:', tx.hash);
  const rc = await tx.wait();
  console.log('Status:', rc.status === 1 ? '✅' : '❌');

  const weth = new ethers.Contract(WETH, wethAbi, wallet);
  const wethBal = await weth.balanceOf(wallet.address);
  console.log('WETH balance:', ethers.formatEther(wethBal));
  if (wethBal > 0n) {
    console.log('Unwrapping WETH -> ETH...');
    const unwrapTx = await weth.withdraw(wethBal);
    await unwrapTx.wait();
    console.log('Unwrap tx:', unwrapTx.hash);
  }

  const ethBal = await provider.getBalance(wallet.address);
  console.log('Final ETH balance:', ethers.formatEther(ethBal));
}
main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
