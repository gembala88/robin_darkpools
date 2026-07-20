import 'dotenv/config';
import { ethers } from 'ethers';
import { swapBackAfterWithdraw } from './lp_withdraw.js';
import { makeProvider } from './provider.js';
import { UC } from './config.js';

const ROBINHOOD = '0x8f100e99dDF699320724e37Cb866770381d47382';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

async function main() {
  const provider = await makeProvider('LP_EXEC_RPC_URL');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const config = UC('lp');
  console.log('Wallet:', wallet.address);
  const result = await swapBackAfterWithdraw(provider, wallet, [ROBINHOOD, WETH], config, true);
  console.log('Hasil:', JSON.stringify(result, null, 2));
}
main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
