// lp_deposit.js — Create LP positions on V3 CASHCAT/WETH + V4 CASHCAT/USDG
//   DRY=1 node lp_deposit.js           # simulate both positions
//   LIVE=1 PRIVATE_KEY=0x.. node lp_deposit.js   # execute real deposits
//   SKIP_SWAP=1 LIVE=1 PRIVATE_KEY=0x.. node lp_deposit.js   # skip swap, use current CASHCAT balance

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, parseEther, formatEther, formatUnits, MaxUint256, AbiCoder, keccak256 } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4, V4_NFPM, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG, NATIVE } from './config.js';
import { V3_NFPM_ABI, V4_NFPM_ABI, ERC20_ABI, UNIVERSAL_ROUTER_ABI, V3_SWAP_ROUTER_ABI } from './abis.js';
import { UC, UCW } from './config.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);

const CASHCAT = LP_V3_CASHCAT_WETH.token0;
const WETH = LP_V3_CASHCAT_WETH.token1;
const USDG = LP_V4_CASHCAT_USDG.key.currency1;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [] }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

// Compute V4 poolId = keccak256(abi.encode(PoolKey))
function computeV4PoolId(key) {
  return keccak256(abi.encode(
    ['tuple(address,address,uint24,int24,address)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
  ));
}

// Get current tick from V3 pool
async function getV3Tick(provider) {
  const slot0 = await provider.call({ to: LP_V3_CASHCAT_WETH.pool, data: '0x3850c7bd' });
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
    slot0
  );
  return Number(decoded[1]);
}

// Get current tick from V4 pool via StateView or PoolManager
async function getV4Tick(provider) {
  const poolId = computeV4PoolId(LP_V4_CASHCAT_USDG.key);
  const stateView = new Contract(V4.stateView, [
    'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ], provider);
  const [, tick] = await stateView.getSlot0.staticCall(poolId);
  return Number(tick);
}

// Compute tick range for one-sided CASHCAT deposit:
//   tickLower = next tickSpacing-multiple ABOVE currentTick  (100% CASHCAT zone)
//   tickUpper = tickLower + rangeTicks  (100% WETH when price goes up rangePct%)
// rangePct = 20 means position exits when CASHCAT pumps 20%.
function computeTickRange(currentTick, rangePct, tickSpacing) {
  const rangeTicks = Math.floor(Math.log(1 + rangePct / 100) / Math.log(1.0001));
  const tickLower = Math.ceil(currentTick / tickSpacing) * tickSpacing;
  const tickUpper = tickLower + Math.ceil(rangeTicks / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

// One-sided deposit: given amount0Desired (CASHCAT), compute liquidity at current tick
function computeLiquidityForAmount0(amount0, tickLower, tickUpper, sqrtPriceX96) {
  const sqrtPrice = Number(sqrtPriceX96) / 2**96;
  const sqrtPriceA = Math.sqrt(Math.pow(1.0001, tickLower));
  const sqrtPriceB = Math.sqrt(Math.pow(1.0001, tickUpper));

  if (sqrtPrice <= sqrtPriceA) {
    return 0n;
  } else if (sqrtPrice < sqrtPriceB) {
    // In range: liquidity = amount0 * sqrtPrice * sqrtPriceB / (sqrtPriceB - sqrtPrice)
    const liq = Number(amount0) * sqrtPrice * sqrtPriceB / (sqrtPriceB - sqrtPrice);
    return BigInt(Math.floor(liq));
  } else {
    return 0n;
  }
}

// Deposit V3 position (one-sided CASHCAT via mint)
async function depositV3(provider, wallet, config) {
  console.log('\n=== V3 CASHCAT/WETH 1% Deposit ===');
  if (!config.enableV3CashcatWeth) { console.log('  SKIPPED (disabled in config)'); return null; }

  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const factory = new Contract(V3.factory, ['function feeAmountTickSpacing(uint24) view returns (int24)'], provider);
  const tickSpacing = Number(await factory.feeAmountTickSpacing(LP_V3_CASHCAT_WETH.fee));

  const currentTick = await getV3Tick(provider);
  const { tickLower, tickUpper } = computeTickRange(currentTick, config.rangeDownPct, tickSpacing);
  console.log(`  Tick spacing: ${tickSpacing}, tickLower % spacing: ${tickLower % tickSpacing}, tickUpper % spacing: ${tickUpper % tickSpacing}`);

  // Get current sqrtPriceX96 from pool
  const slot0 = await provider.call({ to: LP_V3_CASHCAT_WETH.pool, data: '0x3850c7bd' });
  const [sqrtPriceX96] = AbiCoder.defaultAbiCoder().decode(['uint160'], slot0.slice(0, 66));

  const ethAmount = parseEther(String(config.lpSizeEthCashcatWeth));
  const walletAddr = wallet?.address || NATIVE;
  const cashcatBalance = await cashcat.balanceOf(walletAddr);

  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (0% → +${config.rangeDownPct}%)`);
  console.log(`  CASHCAT balance: ${formatEther(cashcatBalance)}`);

  // We need enough CASHCAT for the position (swap already happened)
  // MintParams: token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline
  const amount0Desired = cashcatBalance; // deposit ALL available CASHCAT
  const amount1Desired = 1n; // 1 wei WETH to handle tick-boundary edge case

  const slippagePct = BigInt(config.slippagePct);
  const amount0Min = amount0Desired - (amount0Desired * slippagePct) / 100n;
  const amount1Min = 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + config.deadlineSec);

  // Pre-compute expected liquidity for simulation
  const expectedLiquidity = computeLiquidityForAmount0(
    amount0Desired, tickLower, tickUpper, BigInt(sqrtPriceX96)
  );
  console.log(`  amount0 (CASHCAT): ${formatEther(amount0Desired)}`);
  console.log(`  estimated liquidity: ${expectedLiquidity}`);

  if (!wallet) {
    console.log('  DRY-RUN: no wallet, skipping mint.');
    return { token0: CASHCAT, token1: WETH, fee: 10000, tickLower, tickUpper, amount0Desired, amount1Desired, expectedLiquidity };
  }

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, wallet);

  // Approve NFPM to spend CASHCAT and WETH if needed
  const cashcatAllowance = await cashcat.allowance(wallet.address, V3.nfpm);
  if (cashcatAllowance < amount0Desired) {
    console.log('  Approving CASHCAT for V3 NFPM...');
    const tx = await cashcat.approve.populateTransaction(V3.nfpm, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
    console.log(`  Approve tx: ${app.hash}`);
  }
  const weth = new Contract(WETH, ERC20_ABI, wallet);
  const wethAllowance = await weth.allowance(wallet.address, V3.nfpm);
  if (wethAllowance < amount1Desired) {
    console.log('  Approving WETH for V3 NFPM...');
    const tx = await weth.approve.populateTransaction(V3.nfpm, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
    console.log(`  Approve tx: ${app.hash}`);
  }

  const mintParams = {
    token0: CASHCAT,
    token1: WETH,
    fee: 10000,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient: wallet.address,
    deadline,
  };
  const pop = await nfpm.mint.populateTransaction(mintParams);
  const gas = await wallet.estimateGas(pop);
  console.log(`  Estimated gas: ${gas}`);
  const tx = await wallet.sendTransaction(pop);
  console.log(`  Mint tx: ${tx.hash}`);
  const receipt = await tx.wait();

  // Parse tokenId from Transfer event (from=0x0 → wallet)
  const nfpmLogs = receipt.logs.filter(l => l.address.toLowerCase() === V3.nfpm.toLowerCase());
  let tokenId = null;
  for (const log of nfpmLogs) {
    if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }
  console.log(`  Token ID: ${tokenId}`);

  const position = { dex: 'V3', pool: LP_V3_CASHCAT_WETH.symbol, tokenId: tokenId?.toString(),
    tickLower, tickUpper, amount0: amount0Desired.toString(), amount1: '0',
    block: receipt.blockNumber, tx: tx.hash, ts: Date.now() };
  const state = loadState();
  state.positions.push(position);
  saveState(state);

  console.log('  ✅ V3 position created');
  return position;
}

// Deposit V4 position via modifyLiquiditiesWithoutUnlock
// Uses actions: MINT_POSITION=2
async function depositV4(provider, wallet, config) {
  console.log('\n=== V4 CASHCAT/USDG 0.5% Deposit ===');
  if (!config.enableV4CashcatUsdg) { console.log('  SKIPPED (disabled in config)'); return null; }

  const currentTick = await getV4Tick(provider);
  const { tickLower, tickUpper } = computeTickRange(currentTick, config.rangeDownPct);
  const ethAmount = parseEther(String(config.lpSizeEthCashcatUsdg));

  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (-${config.rangeDownPct}% → 0%)`);

  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const walletAddr = wallet?.address || NATIVE;
  const cashcatBalance = await cashcat.balanceOf(walletAddr);
  console.log(`  CASHCAT balance: ${formatEther(cashcatBalance)}`);

  const poolKey = LP_V4_CASHCAT_USDG.key;
  const keyTuple = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];

  // MINT_POSITION action = 2 (VERIFIED from on-chain tx 0xb26e7e8c...)
  const MINT_POSITION = 2;
  const liquidity = cashcatBalance;
  const amount0Max = (1n << 128n) - 1n;
  const amount1Max = (1n << 128n) - 1n;
  const params = abi.encode(
    ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [keyTuple, tickLower, tickUpper, liquidity, amount0Max, amount1Max, walletAddr, '0x']
  );

  const actions = new Uint8Array([MINT_POSITION]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + config.deadlineSec);

  if (!wallet) {
    console.log('  DRY-RUN: no wallet, skipping.');
    return { key: poolKey, tickLower, tickUpper, liquidity: liquidity.toString(), actions: Array.from(actions) };
  }

  const nfpm = new Contract(V4_NFPM, V4_NFPM_ABI, wallet);

  // Approve NFPM to spend CASHCAT if needed
  const allowance = await cashcat.allowance(wallet.address, V4_NFPM);
  if (allowance < cashcatBalance) {
    console.log('  Approving CASHCAT for V4 NFPM...');
    const tx = await cashcat.approve.populateTransaction(V4_NFPM, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
  }

  // Also need to approve PoolManager via Permit2 for V4
  const permit2 = new Contract(V4.permit2, [
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  ], wallet);
  const pmApp = await permit2.approve.populateTransaction(CASHCAT, V4.poolManager, MaxUint256, 0n);
  try {
    const tx = await wallet.sendTransaction(pmApp);
    await tx.wait();
  } catch { /* may already be approved */ }

  const pop = await nfpm.modifyLiquiditiesWithoutUnlock.populateTransaction(actions, [params]);
  try {
    const tx = await wallet.sendTransaction(pop);
    console.log(`  Mint tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Status: ${receipt.status === 1 ? '✅' : '❌'}`);

    // Log the position
    const position = { dex: 'V4', pool: LP_V4_CASHCAT_USDG.symbol, block: receipt.blockNumber, tx: tx.hash, ts: Date.now() };
    const state = loadState();
    state.positions.push(position);
    saveState(state);

    return position;
  } catch (e) {
    console.log(`  ❌ Tx failed: ${e.shortMessage || e.message}`);
    return null;
  }
}

async function main() {
  const provider = await makeProvider();
  let wallet = null;
  if (process.env.LIVE === '1' && process.env.PRIVATE_KEY) {
    wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);
  } else {
    console.log('DRY-RUN mode (no real tx). Set LIVE=1 PRIVATE_KEY=0x.. to execute.');
  }

  const config = UC('lp');

  console.log('\n=== LP DEPOSIT ========================================');
  console.log('Config:');
  console.log(`  V3 CASHCAT/WETH: ${config.enableV3CashcatWeth ? 'ENABLED' : 'DISABLED'} (${config.lpSizeEthCashcatWeth} ETH)`);
  console.log(`  V4 CASHCAT/USDG: ${config.enableV4CashcatUsdg ? 'ENABLED' : 'DISABLED'} (${config.lpSizeEthCashcatUsdg} ETH)`);
  console.log(`  Range: -${config.rangeDownPct}% → 0%`);
  console.log(`  Slippage: ${config.slippagePct}%`);

  const resultV3 = wallet ? null : { token0: CASHCAT, token1: WETH, fee: 10000 };
  const resultV4 = wallet ? null : { key: LP_V4_CASHCAT_USDG.key };

  if (process.env.SKIP_SWAP !== '1') {
    console.log('\n--- Step 1: Swap ETH → CASHCAT (if needed) ---');
    const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
    const bal = await cashcat.balanceOf(wallet?.address || NATIVE);
    console.log(`  Current CASHCAT balance: ${formatEther(bal)}`);
    if (bal === 0n && wallet) {
      console.log('  ⚠️ No CASHCAT balance. Run lp_swap.js first or set SKIP_SWAP=1.');
      process.exit(1);
    }
  }

  // Step 2: Deposit V3 (if enabled)
  let posV3 = null;
  if (config.enableV3CashcatWeth) {
    posV3 = await depositV3(provider, wallet, config);
  }

  // Step 3: Deposit V4 (if enabled)
  let posV4 = null;
  if (config.enableV4CashcatUsdg) {
    posV4 = await depositV4(provider, wallet, config);
  }

  console.log('\n=== RESULTS ===');
  if (posV3) console.log(`V3: token0=CASHCAT token1=WETH fee=10000 tickL=${posV3.tickLower} tickU=${posV3.tickUpper}`);
  if (posV4) console.log(`V4: currency0=${posV4.key?.currency0?.slice(0,10)||'?'} currency1=${posV4.key?.currency1?.slice(0,10)||'?'}`);

  if (!wallet) console.log('\nDRY-RUN complete. To execute: LIVE=1 PRIVATE_KEY=0x.. node lp_deposit.js');
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
