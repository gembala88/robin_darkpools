// lp_withdraw.js — Close LP positions on V3 CASHCAT/WETH + V4 CASHCAT/USDG
//   DRY=1 node lp_withdraw.js                  # simulate
//   LIVE=1 PRIVATE_KEY=0x.. node lp_withdraw.js   # execute real withdraw
//   TOKEN_ID=100 node lp_withdraw.js            # specific V3 tokenId
//   V4_TOKEN_ID=42 node lp_withdraw.js          # specific V4 tokenId (not yet tracked)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Contract, Wallet, parseEther, formatEther, formatUnits, MaxUint256, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V3, V4_NFPM, LP_V3_CASHCAT_WETH, LP_V4_CASHCAT_USDG, NATIVE } from './config.js';
import { V3_NFPM_ABI, V4_NFPM_ABI, ERC20_ABI } from './abis.js';
import { UC } from './config.js';
import { simulateAndSend, computeDeadline } from './lp_deposit.js';

const abi = AbiCoder.defaultAbiCoder();
const STATE_FILE = new URL('./lp_state.json', import.meta.url);
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [] }; }
}

// ===== V3 WITHDRAW =====
export async function withdrawV3(provider, wallet, tokenId, config) {
  console.log(`\n=== V3 Withdraw tokenId=${tokenId} ===`);

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, wallet || provider);

  if (!wallet) {
    console.log('  DRY-RUN mode');
    const pos = await nfpm.positions.staticCall(tokenId);
    const dt0 = new Contract(pos.token0, ERC20_ABI, provider);
    const dt1 = new Contract(pos.token1, ERC20_ABI, provider);
    const [dsym0, dsym1, d0, d1] = await Promise.all([
      dt0.symbol().catch(() => pos.token0.slice(0, 10)),
      dt1.symbol().catch(() => pos.token1.slice(0, 10)),
      dt0.decimals().catch(() => 18),
      dt1.decimals().catch(() => 18),
    ]);
    console.log(`  token0: ${pos.token0}, token1: ${pos.token1}`);
    console.log(`  liquidity: ${formatUnits(pos.liquidity, 18)}`);
    console.log(`  tokensOwed0: ${formatUnits(pos.tokensOwed0, d0)} ${dsym0}`);
    console.log(`  tokensOwed1: ${formatUnits(pos.tokensOwed1, d1)} ${dsym1}`);
    console.log(`  tickLower: ${pos.tickLower}, tickUpper: ${pos.tickUpper}`);
    return {};
  }

  // Read position + token symbols/decimals dynamically
  const pos = await nfpm.positions.staticCall(tokenId);
  const t0 = new Contract(pos.token0, ERC20_ABI, provider);
  const t1 = new Contract(pos.token1, ERC20_ABI, provider);
  const [sym0, sym1, decimals0, decimals1] = await Promise.all([
    t0.symbol().catch(() => pos.token0.slice(0, 10)),
    t1.symbol().catch(() => pos.token1.slice(0, 10)),
    t0.decimals().catch(() => 18),
    t1.decimals().catch(() => 18),
  ]);

  console.log(`  Position: ${sym0}/${sym1}`);
  console.log(`  Current liquidity: ${formatUnits(pos.liquidity, 18)}`);
  console.log(`  tokensOwed0: ${formatUnits(pos.tokensOwed0, decimals0)} ${sym0}`);
  console.log(`  tokensOwed1: ${formatUnits(pos.tokensOwed1, decimals1)} ${sym1}`);

  // Track collected fees
  let collected0 = 0n;
  let collected1 = 0n;

  // === EXPLICIT NONCE TRACKING + ROBUST DEADLINE ===
  // Get starting nonce ONCE from provider, then increment manually.
  // This prevents FallbackProvider desync — jika RPC switching mid-flow,
  // nonce tetap konsisten karena kita tidak re-query setiap step.
  // Deadline computed from chain timestamp (not Date.now) to avoid clock drift.
  const wd = await computeDeadline(provider, config.deadlineSec);
  const nfpmSigner = nfpm.connect(wallet);
  let nonce = await wallet.getNonce('pending');
  console.log(`  Starting nonce: ${nonce}`);

  // Small helper: simulate populated tx FIRST, broadcast ONLY if simulation passes
  const sendAndVerify = async (label, popTx, expectedOk = true) => {
    const result = await simulateAndSend(wallet, provider, popTx, `${label} (nonce ${nonce})`);
    if (!result.ok) {
      if (expectedOk) throw new Error(`${label} simulation failed — tx not sent`);
      return null;
    }
    const receipt = result.receipt;
    console.log(`  ${label} done — ${receipt.status === 1 ? 'OK' : 'FAIL'} (gasUsed=${receipt.gasUsed?.toString() || '?'})`);
    if (expectedOk && receipt.status !== 1) throw new Error(`${label} FAILED (status=0)`);
    nonce++;  // explicit increment — no re-query
    await new Promise(r => setTimeout(r, 300));  // RPC state sync cooldown
    return receipt;
  };

  if (pos.liquidity === 0n) {
    console.log('  Liquidity already 0, skipping decreaseLiquidity');
    collected0 = pos.tokensOwed0;
    collected1 = pos.tokensOwed1;
  } else {
    // Step 1: decreaseLiquidity
    console.log('\n  Step 1: decreaseLiquidity...');
    const decParams = {
      tokenId,
      liquidity: pos.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: wd,
    };
    const decPop = await nfpmSigner.decreaseLiquidity.populateTransaction(decParams, { nonce });
    await sendAndVerify('decreaseLiquidity', decPop);

    // Re-read tokens owed after decrease (fees may have accrued during decrease)
    const pos2 = await nfpm.positions.staticCall(tokenId);
    collected0 = pos2.tokensOwed0;
    collected1 = pos2.tokensOwed1;
  }

  // Step 2: collect fees
  console.log('\n  Step 2: collect fees...');
  const colParams = {
    tokenId,
    recipient: wallet.address,
    amount0Max: (1n << 128n) - 1n,
    amount1Max: (1n << 128n) - 1n,
  };
  try {
    const colPop = await nfpmSigner.collect.populateTransaction(colParams, { nonce });
    await sendAndVerify('collect', colPop);
    console.log(`  Collected: ${formatUnits(collected0, decimals0)} ${sym0} + ${formatUnits(collected1, decimals1)} ${sym1}`);
  } catch (e) {
    console.log(`  collect FAILED: ${e.shortMessage?.slice(0,60) || e.message?.slice(0,60)}`);
    throw e;  // DO NOT proceed to burn jika collect gagal — tokensOwed masih >0, burn pasti revert
  }

  // Step 3: burn + VERIFY
  console.log('\n  Step 3: burn...');
  try {
    const burnPop = await nfpmSigner.burn.populateTransaction(tokenId, { nonce });
    await sendAndVerify('burn', burnPop);

    // === POST-BURN VERIFICATION ===
    // ownerOf harus revert jika NFT sudah dibakar. Jika tidak revert,
    // burn genuinely gagal — warn dan jangan klaim sukses.
    try {
      const stillOwner = await nfpm.ownerOf.staticCall(tokenId);
      throw new Error(`BURN VERIFICATION FAILED: NFT #${tokenId} masih dimiliki ${stillOwner} — burn tidak benar-benar terjadi!`);
    } catch (e) {
      if (e.message?.includes('BURN VERIFICATION FAILED')) throw e;  // propagate
      // Expected: ownerOf revert = NFT sudah dibakar
      console.log('  NFT burned — verified (ownerOf revert)');
    }
  } catch (e) {
    if (e.message?.includes('BURN VERIFICATION FAILED')) {
      console.error(`\n  ${e.message}`);
      // Kembalikan collected fees TAPI tandai bahwa burn gagal
      return {
        fee0: formatUnits(collected0, decimals0),
        fee1: formatUnits(collected1, decimals1),
        sym0, sym1, token0: pos.token0, token1: pos.token1,
        _burnFailed: true,
      };
    }
    console.log(`  burn tx failed: ${e.shortMessage?.slice(0,60) || e.message?.slice(0,60)}`);
    throw e;
  }

  // Show final balances
  const finalBal0 = await t0.balanceOf(wallet.address);
  const finalBal1 = await t1.balanceOf(wallet.address);
  console.log(`\n  Final ${sym0} balance: ${formatUnits(finalBal0, decimals0)}`);
  console.log(`  Final ${sym1} balance: ${formatUnits(finalBal1, decimals1)}`);

  return {
    fee0: formatUnits(collected0, decimals0),
    fee1: formatUnits(collected1, decimals1),
    sym0, sym1,
    token0: pos.token0, token1: pos.token1,
  };
}

// ===== V4 WITHDRAW =====
// tokenId optional: if null, looks up from state or V4_TOKEN_ID env.
export async function withdrawV4(provider, wallet, config, tokenId = null) {
  console.log(`\n=== V4 Withdraw ===`);
  if (!config.enableV4CashcatUsdg) { console.log('  SKIPPED (disabled)'); return; }

  if (tokenId === null) {
    const state = loadState();
    const v4Pos = state.positions.find(p => p.dex === 'V4');
    if (!v4Pos && !process.env.V4_TOKEN_ID) {
      console.log('  No V4 position in state and no V4_TOKEN_ID env. Skipping.');
      return;
    }
    tokenId = BigInt(process.env.V4_TOKEN_ID || v4Pos.tokenId || 0);
  } else {
    tokenId = BigInt(tokenId);
  }
  const poolKey = LP_V4_CASHCAT_USDG.key;
  const currency0 = poolKey.currency0;
  const currency1 = poolKey.currency1;

  // Read token symbols/decimals dynamically
  const t0 = new Contract(currency0, ERC20_ABI, provider);
  const t1 = new Contract(currency1, ERC20_ABI, provider);
  const [sym0, sym1, decimals0, decimals1] = await Promise.all([
    t0.symbol().catch(() => currency0.slice(0, 10)),
    t1.symbol().catch(() => currency1.slice(0, 10)),
    t0.decimals().catch(() => 18),
    t1.decimals().catch(() => 18),
  ]);

  // Use getPositionLiquidity(uint256)
  const v4Reader = new Contract(V4_NFPM, [
    'function getPositionLiquidity(uint256) view returns (uint128)',
  ], provider);
  const liquidity = await v4Reader.getPositionLiquidity(tokenId);
  console.log(`  Token ID: ${tokenId}`);
  console.log(`  Position: ${sym0}/${sym1}`);
  console.log(`  Liquidity: ${formatUnits(liquidity, 18)}`);

  if (liquidity === 0n) {
    console.log('  Liquidity already 0. Nothing to withdraw.');
    return {};
  }

  if (!wallet) {
    console.log('  DRY-RUN mode');
    console.log(`  Would call modifyLiquidities with actions: DECREASE_LIQUIDITY(1) + TAKE_PAIR(0x11)`);
    return {};
  }

  // Actions: DECREASE_LIQUIDITY(1) + TAKE_PAIR(0x11)
  const decreaseParams = abi.encode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    [tokenId, liquidity, 0n, 0n, '0x']
  );
  const takeParams = abi.encode(
    ['address', 'address', 'address'],
    [currency0, currency1, wallet.address]
  );

  const DECREASE = 1;
  const TAKE_PAIR = 0x11;
  const actions = new Uint8Array([DECREASE, TAKE_PAIR]);
  const paramsList = [decreaseParams, takeParams];

  console.log(`  Actions: [DECREASE_LIQUIDITY(1), TAKE_PAIR(0x11)]`);

  const unlockData = abi.encode(
    ['bytes', 'bytes[]'],
    [actions, paramsList]
  );
  const deadline = await computeDeadline(provider, config.deadlineSec);

  console.log('  Calling modifyLiquidities (with auto-unlock)...');
  const pop = await nfpm.modifyLiquidities.populateTransaction(unlockData, deadline);

  const result = await simulateAndSend(wallet, provider, pop, 'V4 Withdraw');
  if (!result.ok) return null;

  // Show final balances
  const finalBal0 = await t0.balanceOf(wallet.address);
  const finalBal1 = await t1.balanceOf(wallet.address);
  console.log(`  Final ${sym0} balance: ${formatUnits(finalBal0, decimals0)}`);
  console.log(`  Final ${sym1} balance: ${formatUnits(finalBal1, decimals1)}`);

  return {
    sym0, sym1,
    token0: currency0, token1: currency1,
  };
}

// ===== SWAP-BACK TOKENS TO ETH =====
export async function swapBackAfterWithdraw(provider, wallet, tokens, config, forceSwap = false) {
  const doSwap = forceSwap || process.env.SWAP_BACK === '1';
  if (!doSwap) {
    console.log('\n=== Swap-back to ETH: SKIPPED (set SWAP_BACK=1 or forceSwap=true to enable) ===');
    return { skipped: true };
  }
  console.log('\n=== Swap-back to ETH ===');

  const WETH = LP_V3_CASHCAT_WETH.token1;
  const SWAP_ROUTER = V3.swapRouter02;
  const QUOTER = V3.quoterV2;
  const addr = wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE);
  const ethBefore = wallet ? await provider.getBalance(addr) : 0n;
  const swapped = [];
  const failed = [];

  for (const token of tokens) {
    if (token.toLowerCase() === WETH.toLowerCase()) {
      console.log(`  ${token.slice(0, 10)}: WETH, skip swap (will unwrap at end)`);
      continue;
    }
    const t = new Contract(token, ERC20_ABI, provider);
    const [bal, sym, dec] = await Promise.all([
      t.balanceOf(addr),
      t.symbol().catch(() => token.slice(0, 10)),
      t.decimals().catch(() => 18),
    ]);
    if (bal === 0n) {
      console.log(`  ${sym}: balance 0, skip`);
      continue;
    }
    // Try multiple V3 fee tiers: 0.01%, 0.05%, 0.3%, 1%
    const FEE_TIERS = [100, 500, 3000, 10000];
    const quoter = new Contract(QUOTER, [
      'function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)',
    ], provider);
    let amountOut, fee;
    for (const f of FEE_TIERS) {
      try {
        const result = await quoter.quoteExactInputSingle.staticCall([token, WETH, bal, f, 0]);
        amountOut = result[0];
        fee = f;
        break;
      } catch { /* try next fee tier */ }
    }
    if (!fee) {
      console.log(`  ${sym}: no pool found in any fee tier, skip`);
      failed.push({ token, sym });
      continue;
    }
    const amountOutMin = amountOut - (amountOut * BigInt(config.slippagePct)) / 100n;
    console.log(`  ${sym} → WETH: ${formatUnits(bal, dec)} → ${formatEther(amountOut)} (fee=${fee}, min ${formatEther(amountOutMin)})`);

    if (!wallet) continue; // DRY: skip the rest, next token

    // Approve SwapRouter if needed
    const tw = new Contract(token, ERC20_ABI, wallet);
    const allowance = await tw.allowance(wallet.address, SWAP_ROUTER);
    if (allowance < bal) {
      console.log(`    Approving ${sym} for SwapRouter...`);
      const appTx = await tw.approve(SWAP_ROUTER, MaxUint256);
      await appTx.wait();
      console.log(`    Approve tx: ${appTx.hash}`);
    }

    // Execute swap with the found fee tier (retry once with wider slippage if needed)
    const swapSlippage = config.swapBackSlippagePct ?? config.slippagePct ?? 1;
    const retrySlippage = config.swapBackRetrySlippagePct ?? 3;
    const router = new Contract(SWAP_ROUTER, [
      'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)',
    ], wallet);

    const doSwap = async (slippage, quoteOut, quoteFee, attemptLabel) => {
      const minOut = quoteOut - (quoteOut * BigInt(slippage)) / 100n;
      console.log(`    ${attemptLabel}: ${sym}→WETH slippage=${slippage}% min=${formatEther(minOut)}`);
      const params = [token, WETH, quoteFee, wallet.address, bal, minOut, 0];
      const pop = await router.exactInputSingle.populateTransaction(params);
      return await simulateAndSend(wallet, provider, pop, `${sym}→WETH (${attemptLabel})`);
    };

    const reQuote = async () => {
      for (const f of FEE_TIERS) {
        try {
          const result = await quoter.quoteExactInputSingle.staticCall([token, WETH, bal, f, 0]);
          return { amountOut: result[0], fee: f };
        } catch { /* try next */ }
      }
      return null;
    };

    let r = await doSwap(swapSlippage, amountOut, fee, 'attempt 1').catch(() => ({ ok: false }));
    if (!r.ok && retrySlippage > swapSlippage) {
      console.log(`    ⚠️ ${sym} swap gagal — re-quote + retry dengan slippage ${retrySlippage}%`);
      const fresh = await reQuote();
      if (fresh) { amountOut = fresh.amountOut; fee = fresh.fee; }
      r = await doSwap(retrySlippage, amountOut, fee, 'attempt 2').catch(() => ({ ok: false }));
    }
    if (r.ok) swapped.push({ sym, token, amountIn: formatUnits(bal, dec), amountOutWeth: formatEther(amountOut), tx: r.tx });
    else failed.push({ token, sym });
  }

  // Unwrap WETH → ETH
  const result = { swapped, failed, skipped: false };
  const wethC = new Contract(WETH, [...ERC20_ABI, 'function withdraw(uint256)'], wallet || provider);
  const wethBal = await wethC.balanceOf(addr);
  console.log(`\n  WETH balance: ${formatEther(wethBal)}`);
  let ethBal = null;
  if (wethBal > 0n && wallet) {
    console.log('  Unwrapping WETH → ETH...');
    const pop = await wethC.withdraw.populateTransaction(wethBal);
    const r = await simulateAndSend(wallet, provider, pop, 'WETH→ETH');
    if (r.ok) {
      result.unwrapTx = r.tx;
      ethBal = await provider.getBalance(wallet.address);
      console.log(`  Final ETH balance: ${formatEther(ethBal)}`);
    }
  } else if (wethBal > 0n) {
    console.log('  DRY: would unwrap WETH → ETH');
  }
  result.ethFromUnwrap = formatEther(wethBal);

  if (swapped.length > 0 || ethBal !== null) {
    const ethDelta = wallet ? formatEther(await provider.getBalance(addr) - ethBefore) : '?';
    result.ethDelta = ethDelta;
    result.summary = `Swapped ${swapped.length} token(s) → +${ethDelta} ETH`;
  } else {
    result.summary = 'No tokens swapped';
  }

  if (failed.length > 0) {
    result.failedSymbols = failed.map(t => t.sym || t.token?.slice(0, 10));
    console.log(`\n  ⚠️ ${failed.length} token(s) swap failed: ${result.failedSymbols.join(', ')}`);
    result.summary += `, ${failed.length} token(s) gagal`;
  }
  console.log(`  Swap-back complete. ${result.summary}`);
  return result;
}

async function main() {
  const provider = await makeProvider('LP_RPC_URL');
  let wallet = null;
  const isDry = process.env.DRY !== '0';
  if (!isDry && process.env.PRIVATE_KEY) {
    wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);
  } else {
    console.log('DRY-RUN mode (no real tx). Set DRY=0 PRIVATE_KEY=0x.. to execute (independent of arb LIVE flag).');
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
      await swapBackAfterWithdraw(provider, wallet, [LP_V3_CASHCAT_WETH.token0, LP_V3_CASHCAT_WETH.token1], config);
    } else if (v3InState?.tokenId) {
      await withdrawV3(provider, wallet, BigInt(v3InState.tokenId), config);
      await swapBackAfterWithdraw(provider, wallet, [LP_V3_CASHCAT_WETH.token0, LP_V3_CASHCAT_WETH.token1], config);
    } else {
      console.log('\nNo V3 position found. Use TOKEN_ID= env or run deposit first.');
      console.log('DRY-RUN: showing V3 withdraw plan:');
      await withdrawV3(provider, wallet, BigInt(1), config);
    }
  }

  // V4 withdraw
  if (config.enableV4CashcatUsdg) {
    const v4TokenId = process.env.V4_TOKEN_ID || null;
    await withdrawV4(provider, wallet, config, v4TokenId);
    const v4Key = LP_V4_CASHCAT_USDG.key;
    await swapBackAfterWithdraw(provider, wallet, [v4Key.currency0, v4Key.currency1], config);
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
      console.log('\nState cleaned.');
    }
  }

  if (!wallet) console.log('\nDRY-RUN complete. To execute: DRY=0 PRIVATE_KEY=0x.. node lp_withdraw.js');
}

// Only auto-execute if this is the main module (not imported)
const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(import.meta.url);
if (isMain) {
  main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
}
