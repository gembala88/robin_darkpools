// lp_withdraw.js — Close LP positions on V3 CASHCAT/WETH + V4 CASHCAT/USDG
//   DRY=1 node lp_withdraw.js                  # simulate
//   LIVE=1 PRIVATE_KEY=0x.. node lp_withdraw.js   # execute real withdraw
//   TOKEN_ID=100 node lp_withdraw.js            # specific V3 tokenId
//   V4_TOKEN_ID=42 node lp_withdraw.js          # specific V4 tokenId (not yet tracked)

import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Wallet, parseEther, formatEther, formatUnits, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4_NFPM, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG } from './config.js';
import { V3_NFPM_ABI, V4_NFPM_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);
const CASHCAT = LP_V3_CASHCAT_WETH.token0;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [] }; }
}

// ===== V3 WITHDRAW =====
async function withdrawV3(provider, wallet, tokenId, config) {
  console.log(`\\n=== V3 Withdraw tokenId=${tokenId} ===`);

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, wallet || provider);

  if (!wallet) {
    console.log('  DRY-RUN mode');
    const pos = await nfpm.positions.staticCall(tokenId);
    console.log(`  token0: ${pos.token0}, token1: ${pos.token1}`);
    console.log(`  liquidity: ${formatUnits(pos.liquidity, 18)}`);
    console.log(`  tokensOwed0: ${formatUnits(pos.tokensOwed0, 18)}`);
    console.log(`  tokensOwed1: ${formatEther(pos.tokensOwed1)}`);
    console.log(`  tickLower: ${pos.tickLower}, tickUpper: ${pos.tickUpper}`);
    return;
  }

  // Step 1: Get current position state
  const pos = await nfpm.positions.staticCall(tokenId);
  console.log(`  Current liquidity: ${formatUnits(pos.liquidity, 18)}`);
  console.log(`  tokensOwed0: ${formatUnits(pos.tokensOwed0, 18)} CASHCAT`);
  console.log(`  tokensOwed1: ${formatEther(pos.tokensOwed1)} WETH`);

  if (pos.liquidity === 0n) {
    console.log('  Liquidity already 0, skipping decreaseLiquidity');
  } else {
    // Step 1: decreaseLiquidity
    console.log('\\n  Step 1: decreaseLiquidity...');
    const decParams = {
      tokenId,
      liquidity: pos.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + config.deadlineSec),
    };
    const decPop = await nfpm.decreaseLiquidity.populateTransaction(decParams);
    const decGas = await wallet.estimateGas(decPop);
    console.log(`  Est gas: ${decGas}`);
    const decTx = await wallet.sendTransaction(decPop);
    console.log(`  decreaseLiquidity tx: ${decTx.hash}`);
    await decTx.wait();
    console.log('  ✅ decrease done');
  }

  // Step 2: collect fees
  console.log('\\n  Step 2: collect fees...');
  const colParams = {
    tokenId,
    recipient: wallet.address,
    amount0Max: MaxUint256,
    amount1Max: MaxUint256,
  };
  const colPop = await nfpm.collect.populateTransaction(colParams);
  try {
    const colTx = await wallet.sendTransaction(colPop);
    console.log(`  collect tx: ${colTx.hash}`);
    await colTx.wait();
    console.log('  ✅ collect done');
  } catch (e) {
    console.log(`  collect failed (may be fine): ${e.shortMessage?.slice(0,60) || e.message?.slice(0,60)}`);
  }

  // Step 3: burn (optional)
  console.log('\\n  Step 3: burn...');
  const burnPop = await nfpm.burn.populateTransaction(tokenId);
  try {
    const burnTx = await wallet.sendTransaction(burnPop);
    console.log(`  burn tx: ${burnTx.hash}`);
    await burnTx.wait();
    console.log('  ✅ NFT burned');
  } catch (e) {
    console.log(`  burn failed (expected if liquidity>0): ${e.shortMessage?.slice(0,60) || e.message?.slice(0,60)}`);
  }

  // Show final balances
  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const finalBal = await cashcat.balanceOf(wallet.address);
  console.log(`\\n  Final CASHCAT balance: ${formatEther(finalBal)}`);
}

// ===== V4 WITHDRAW =====
async function withdrawV4(provider, wallet, config) {
  console.log(`\\n=== V4 Withdraw (CASHCAT/USDG) ===`);
  if (!config.enableV4CashcatUsdg) { console.log('  SKIPPED (disabled)'); return; }

  // V4 NFPM doesn't have a simple decreaseLiquidity — uses modifyLiquiditiesWithoutUnlock
  // DECREASE_LIQUIDITY action = 1 (VERIFIED from on-chain tx 0x66cb2554...)
  // Need tokenId from state file or env
  const state = loadState();
  const v4Pos = state.positions.find(p => p.dex === 'V4');
  if (!v4Pos && !process.env.V4_TOKEN_ID) {
    console.log('  No V4 position in state and no V4_TOKEN_ID env. Skipping.');
    return;
  }

  const nfpm = new Contract(V4_NFPM, V4_NFPM_ABI, wallet || provider);
  const tokenId = BigInt(process.env.V4_TOKEN_ID || v4Pos.tokenId || 0);

  if (!wallet) {
    console.log('  DRY-RUN mode');
    console.log(`  V4 NFPM does not have a standalone decreaseLiquidity function.`);
    console.log(`  Using modifyLiquiditiesWithoutUnlock with DECREASE_LIQUIDITY action.`);
    console.log(`  Token ID: ${tokenId}`);
    return;
  }

  // For V4, use modifyLiquiditiesWithoutUnlock with DECREASE_LIQUIDITY action
  // DECREASE_LIQUIDITY = 1, TAKE = 21 (standard V4 Actions library)
  const DECREASE = 1;
  const TAKE = 21;

  // Get current position info (positions(uint256) selector is 0x99fbab88)
  const posData = await provider.call({
    to: V4_NFPM,
    data: '0x99fbab88' + tokenId.toString(16).padStart(64, '0'),
  });
  const pos = AbiCoder.defaultAbiCoder().decode(
    ['uint96', 'address', 'address', 'address', 'uint24', 'int24', 'int24',
     'uint128', 'uint256', 'uint256', 'uint128', 'uint128'],
    posData
  );
  const liquidity = pos[7];
  const currency0 = pos[2];
  const currency1 = pos[3];
  console.log(`  Position: ${currency0} / ${currency1}`);
  console.log(`  Liquidity: ${formatUnits(liquidity, 18)}`);

  if (liquidity === 0n) {
    console.log('  Liquidity already 0. Nothing to withdraw.');
    return;
  }

  // Build actions: DECREASE followed by TAKE for both currencies
  const decreaseParams = abi.encode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    [tokenId, liquidity, 0n, 0n, '0x']
  );

  const actions = new Uint8Array([DECREASE]);
  console.log('  Calling modifyLiquiditiesWithoutUnlock...');
  const pop = await nfpm.modifyLiquiditiesWithoutUnlock.populateTransaction(
    actions, [decreaseParams]
  );

  try {
    const tx = await wallet.sendTransaction(pop);
    console.log(`  Withdraw tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Status: ${receipt.status === 1 ? '✅' : '❌'}`);
  } catch (e) {
    console.log(`  ❌ Tx failed: ${e.shortMessage?.slice(0,100) || e.message?.slice(0,100)}`);

    // Fallback: try multicall approach
    console.log('\\n  Trying multicall fallback...');
    const mcPop = await nfpm.multicall.populateTransaction([pop.data]);
    try {
      const mcTx = await wallet.sendTransaction(mcPop);
      console.log(`  Multicall tx: ${mcTx.hash}`);
      await mcTx.wait();
      console.log('  ✅ Done via multicall');
    } catch (e2) {
      console.log(`  ❌ Multicall also failed: ${e2.shortMessage?.slice(0,60)}`);
    }
  }

  // Show final balances
  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const finalBal = await cashcat.balanceOf(wallet.address);
  console.log(`  Final CASHCAT balance: ${formatEther(finalBal)}`);
}

async function main() {
  const provider = await makeProvider();
  let wallet = null;
  if (process.env.LIVE === '1' && process.env.PRIVATE_KEY) {
    wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);
  } else {
    console.log('DRY-RUN mode. Set LIVE=1 PRIVATE_KEY=0x.. to execute.');
  }

  const config = UC('lp');

  // Determine which positions to withdraw
  const v3TokenId = process.env.TOKEN_ID || null;
  const state = loadState();

  console.log('\n=== LP WITHDRAW ========================================');

  // V3 withdraw
  if (config.enableV3CashcatWeth) {
    const v3InState = state.positions.find(p => p.dex === 'V3');
    if (v3TokenId) {
      await withdrawV3(provider, wallet, BigInt(v3TokenId), config);
    } else if (v3InState?.tokenId) {
      await withdrawV3(provider, wallet, BigInt(v3InState.tokenId), config);
    } else {
      console.log('\\nNo V3 position found. Use TOKEN_ID= env or run deposit first.');
      console.log('DRY-RUN: showing V3 withdraw plan:');
      await withdrawV3(provider, wallet, BigInt(1), config);
    }
  }

  // V4 withdraw
  if (config.enableV4CashcatUsdg) {
    await withdrawV4(provider, wallet, config);
  }

  // Clean state on successful withdraw
  if (wallet) {
    const updated = loadState();
    if (v3TokenId || process.env.V4_TOKEN_ID) {
      updated.positions = updated.positions.filter(p =>
        !(p.dex === 'V3' && p.tokenId === v3TokenId) &&
        !(p.dex === 'V4' && p.tokenId === process.env.V4_TOKEN_ID)
      );
      fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2));
      console.log('\\nState cleaned.');
    }
  }

  if (!wallet) console.log('\nDRY-RUN complete.');
}

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
