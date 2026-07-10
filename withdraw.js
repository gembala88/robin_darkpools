// withdraw.js — pull ETH out of the ArbExecutor contract to the owner wallet.
//   node withdraw.js                 # withdraw everything
//   LEAVE_ETH=0.006 node withdraw.js  # withdraw all but 0.006 (keep trading capital)
//   AMOUNT_ETH=0.01 node withdraw.js  # withdraw an exact amount
import 'dotenv/config';
import { Wallet, Contract, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('set PRIVATE_KEY in .env');
  if (!process.env.EXECUTOR_ADDR) throw new Error('set EXECUTOR_ADDR in .env');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const exec = new Contract(process.env.EXECUTOR_ADDR, ['function withdraw(uint256)', 'function owner() view returns (address)'], wallet);

  const owner = await exec.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('wallet is not the contract owner');

  const bal = await provider.getBalance(process.env.EXECUTOR_ADDR);
  let amount;
  if (process.env.AMOUNT_ETH) amount = parseEther(process.env.AMOUNT_ETH);
  else if (process.env.LEAVE_ETH) { const leave = parseEther(process.env.LEAVE_ETH); amount = bal > leave ? bal - leave : 0n; }
  else amount = bal;

  console.log('contract balance:', formatEther(bal), 'ETH | withdrawing:', formatEther(amount), 'ETH');
  if (amount <= 0n) { console.log('nothing to withdraw'); process.exit(0); }
  if (amount > bal) throw new Error('amount exceeds contract balance');

  const tx = await exec.withdraw(amount);
  await tx.wait();
  console.log('tx', tx.hash);
  console.log('contract now:', formatEther(await provider.getBalance(process.env.EXECUTOR_ADDR)), '| wallet:', formatEther(await provider.getBalance(wallet.address)));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
