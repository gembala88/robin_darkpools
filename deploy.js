// deploy.js — deploy ArbExecutor to Robinhood Chain and run setup() approvals.
//   PRIVATE_KEY=0x... node deploy.js
// Optionally fund it in the same run: FUND_ETH=0.05 PRIVATE_KEY=0x... node deploy.js
// After it prints the address, put it in .env as EXECUTOR_ADDR to enable atomic mode.

import 'dotenv/config';
import fs from 'node:fs';
import { ContractFactory, Wallet, parseEther, formatEther } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE, V4 } from './config.js';

const artifact = JSON.parse(fs.readFileSync(new URL('./build/ArbExecutor.json', import.meta.url)));

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('set PRIVATE_KEY');
  const provider = await makeProvider();
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log('deployer', wallet.address, 'balance', formatEther(bal), 'ETH');

  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log('deploying ArbExecutor...');
  const c = await factory.deploy(CURVE.address, V4.universalRouter, V4.permit2);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log('deployed at', addr);
  console.log('(token approvals happen automatically on first arb per token)');

  if (process.env.FUND_ETH) {
    const amt = parseEther(process.env.FUND_ETH);
    console.log(`funding ${formatEther(amt)} ETH...`);
    await (await wallet.sendTransaction({ to: addr, value: amt })).wait();
    console.log('funded. contract balance', formatEther(await provider.getBalance(addr)), 'ETH');
  }

  console.log(`\nAdd to .env:  EXECUTOR_ADDR=${addr}`);
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
