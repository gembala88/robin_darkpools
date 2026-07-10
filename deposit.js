// deposit.js — fund the ArbExecutor contract with working capital. The bot trades
// from the contract's balance (atomic curveToV4/v4ToCurve), so it must hold ETH.
//   AMOUNT_ETH=0.006 node deposit.js
import 'dotenv/config';
import { Wallet, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('set PRIVATE_KEY in .env');
  if (!process.env.EXECUTOR_ADDR) throw new Error('set EXECUTOR_ADDR in .env (deploy first)');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const amount = parseEther(process.env.AMOUNT_ETH || '0.006');

  console.log(`funding ${process.env.EXECUTOR_ADDR} with ${formatEther(amount)} ETH...`);
  const tx = await wallet.sendTransaction({ to: process.env.EXECUTOR_ADDR, value: amount });
  await tx.wait();
  console.log('tx', tx.hash);
  console.log('contract balance:', formatEther(await provider.getBalance(process.env.EXECUTOR_ADDR)), 'ETH');
  console.log('wallet balance  :', formatEther(await provider.getBalance(wallet.address)), 'ETH');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
