// lp_deposit.js — Create LP positions on V3 CASHCAT/WETH + V4 CASHCAT/USDG
//   DRY=1 node lp_deposit.js           # simulate both positions
//   LIVE=1 PRIVATE_KEY=0x.. node lp_deposit.js   # execute real deposits
//   SKIP_SWAP=1 LIVE=1 PRIVATE_KEY=0x.. node lp_deposit.js   # skip swap, use current CASHCAT balance

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
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
const MAX_ACTIVE_POSITIONS = Number(process.env.MAX_LP_POSITIONS || 3);

// Tokens considered "shared base" (not unique to a pair)
const STABLE_OR_WRAPPED = new Set([WETH.toLowerCase(), USDG.toLowerCase()]);

// Extract the unique (non-stable) token address from a saved position
function positionUniqueToken(pos) {
  const tokens = pos.dex === 'V3' ? [pos.token0, pos.token1]
    : pos.dex === 'V4' ? [pos.currency0, pos.currency1]
    : [];
  for (const t of tokens) {
    if (t && !STABLE_OR_WRAPPED.has(t.toLowerCase())) return t;
  }
  return null;
}

const ERROR_MAP = {
  '0x25fbd8be': 'AlreadySubscribed(uint256,address)',
  '0xace94481': 'BurnNotificationReverted(address,bytes)',
  '0x6f5ffb7e': 'ContractLocked()',
  '0xbfb22adf': 'DeadlinePassed(uint256)',
  '0x3351b260': 'DeltaNotNegative(address)',
  '0x4c085bf1': 'DeltaNotPositive(address)',
  '0xed43c3a6': 'GasLimitTooLow()',
  '0xaaad13f7': 'InputLengthMismatch()',
  '0xf4d678b8': 'InsufficientBalance()',
  '0xb0669cbc': 'InvalidContractSignature()',
  '0x38bbd576': 'InvalidEthSender()',
  '0x8baa579f': 'InvalidSignature()',
  '0x4be6321b': 'InvalidSignatureLength()',
  '0x815e1d64': 'InvalidSigner()',
  '0x31e30ad0': 'MaximumAmountExceeded(uint128,uint128)',
  '0x12816f22': 'MinimumAmountInsufficient(uint128,uint128)',
  '0xe94f10e2': 'ModifyLiquidityNotificationReverted(address,bytes)',
  '0x7c402b21': 'NoCodeSubscriber()',
  '0x80e05c00': 'NoSelfPermit()',
  '0x1fb09b80': 'NonceAlreadyUsed()',
  '0x0ca968d8': 'NotApproved(address)',
  '0xae18210a': 'NotPoolManager()',
  '0x237e6c28': 'NotSubscribed()',
  '0xd4b05fe0': 'PoolManagerMustBeLocked()',
  '0x5a9165ff': 'SignatureDeadlineExpired()',
  '0x81ea5e9e': 'SubscriptionReverted(address,bytes)',
  '0x82b42900': 'Unauthorized()',
  '0x5cda29d7': 'UnsupportedAction(uint256)',
  '0x5090d6c6': 'AlreadyUnlocked()',
  '0x6e6c9830': 'CurrenciesOutOfOrderOrEqual(address,address)',
  '0x5212cba1': 'CurrencyNotSettled()',
  '0x0d89438e': 'DelegateCallNotAllowed()',
  '0x48f5c3ed': 'InvalidCaller()',
  '0x54e3ca0d': 'ManagerLocked()',
  '0xbda73abf': 'MustClearExactPositiveDelta()',
  '0xb0ec849e': 'NonzeroNativeValue()',
  '0x486aa307': 'PoolNotInitialized()',
  '0xc79e5948': 'ProtocolFeeCurrencySynced()',
  '0xa7abe2f7': 'ProtocolFeeTooLarge(uint24)',
  '0xbe8b8507': 'SwapAmountCannotBeZero()',
  '0xb70024f8': 'TickSpacingTooLarge(int24)',
  '0xe9e90588': 'TickSpacingTooSmall(int24)',
  '0x30d21641': 'UnauthorizedDynamicLPFeeUpdate()',
  '0xd81b2f2e': 'AllowanceExpired(uint256)',
  '0x24d35a26': 'ExcessiveInvalidation()',
  '0xf96fb071': 'InsufficientAllowance(uint256)',
  '0x3728b83d': 'InvalidAmount(uint256)',
  '0x756688fe': 'InvalidNonce()',
  '0xcd21db4f': 'SignatureExpired(uint256)',
  '0x3b99b53d': 'SliceOutOfBounds()',
};

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { positions: [] }; }
}
export function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

// Compute V4 poolId = keccak256(abi.encode(PoolKey))
export function computeV4PoolId(key) {
  return keccak256(abi.encode(
    ['tuple(address,address,uint24,int24,address)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
  ));
}

// Get current tick from V3 pool
async function getV3Tick(provider, poolAddr = LP_V3_CASHCAT_WETH.pool) {
  const slot0 = await provider.call({ to: poolAddr, data: '0x3850c7bd' });
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
    slot0
  );
  return Number(decoded[1]);
}

// Get current tick and sqrtPriceX96 from V4 pool
async function getV4Slot0(provider, poolKey = LP_V4_CASHCAT_USDG.key) {
  const poolId = computeV4PoolId(poolKey);
  const stateView = new Contract(V4.stateView, [
    'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ], provider);
  return await stateView.getSlot0.staticCall(poolId);
}
async function getV4Tick(provider) {
  const [, tick] = await getV4Slot0(provider);
  return Number(tick);
}

// Compute sqrtPriceX96 at a given tick RELATIVE to current tick+sqrtPrice.
// Uses 1.0001^((tick - currentTick)/2) * sqrtPriceX96 — safe for |diff| < ~10k.
export function sqrtPriceAtTick(tick, currentTick, currentSqrtPriceX96) {
  const diff = tick - currentTick;
  if (diff === 0) return currentSqrtPriceX96;
  const Q96 = 1n << 96n;
  const ratio = Math.pow(1.0001, diff / 2);
  return currentSqrtPriceX96 * BigInt(Math.round(ratio * Number(Q96))) / Q96;
}

// Compute tick range SYMMETRIC around current tick:
//   tickLower = currentTick - rangePct%
//   tickUpper = currentTick + rangePct%
export function computeTickRange(currentTick, symmetricPct, tickSpacing) {
  const halfRangeTicks = Math.floor(Math.log(1 + symmetricPct / 100) / Math.log(1.0001));
  const halfRangeAligned = Math.ceil(halfRangeTicks / tickSpacing) * tickSpacing;
  const tickLower = Math.floor(currentTick / tickSpacing) * tickSpacing - halfRangeAligned;
  const tickUpper = Math.ceil(currentTick / tickSpacing) * tickSpacing + halfRangeAligned;
  return { tickLower, tickUpper };
}

// Two-sided liquidity: min(L0, L1) using standard V3 formula.
// amount0 = CASHCAT, amount1 = WETH.
export function computeLiquidity(amount0, amount1, sqrtPriceX96, currentTick, tickLower, tickUpper) {
  const sqrtPX96 = BigInt(sqrtPriceX96);
  const sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, sqrtPX96);
  const sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, sqrtPX96);
  const Q96 = 1n << 96n;
  if (sqrtPX96 <= sqrtPaX96 || sqrtPX96 >= sqrtPbX96) return 0n;
  const L0 = amount0 * sqrtPX96 * sqrtPbX96 / ((sqrtPbX96 - sqrtPX96) * Q96);
  const L1 = amount1 * Q96 / (sqrtPX96 - sqrtPaX96);
  return L0 < L1 ? L0 : L1;
}

export async function depositV3(provider, wallet, config, poolInfo = null) {
  const useDefault = !poolInfo;
  const token0 = useDefault ? CASHCAT : poolInfo.token0;
  const token1 = useDefault ? WETH : poolInfo.token1;
  const fee = useDefault ? 10000 : poolInfo.fee;
  const poolAddr = useDefault ? LP_V3_CASHCAT_WETH.pool : poolInfo.poolAddr;
  const symbol = useDefault ? LP_V3_CASHCAT_WETH.symbol
    : `${poolInfo.baseToken?.symbol || '?'}/${poolInfo.quoteToken?.symbol || '?'}`;
  const decimals0 = useDefault ? 18 : poolInfo.decimals0;
  const decimals1 = useDefault ? 18 : poolInfo.decimals1;
  const tickSpacing = useDefault
    ? Number(await (new Contract(V3.factory, ['function feeAmountTickSpacing(uint24) view returns (int24)'], provider))
        .feeAmountTickSpacing(LP_V3_CASHCAT_WETH.fee))
    : poolInfo.tickSpacing;

  console.log(`\n=== V3 ${symbol} ${fee / 10000}% Deposit ===`);
  if (useDefault && !config.enableV3CashcatWeth) { console.log('  SKIPPED (disabled in config)'); return null; }

  const t0 = new Contract(token0, ERC20_ABI, provider);
  const t1 = new Contract(token1, ERC20_ABI, provider);
  const symmetricPct = Number(config.rangeSymmetricPct || 15);

  const currentTick = await getV3Tick(provider, poolAddr);
  const entryTick = currentTick;
  const { tickLower, tickUpper } = computeTickRange(currentTick, symmetricPct, tickSpacing);

  const slot0 = await provider.call({ to: poolAddr, data: '0x3850c7bd' });
  const [sqrtPriceX96] = AbiCoder.defaultAbiCoder().decode(['uint160'], slot0.slice(0, 66));

  const walletAddr = wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE);
  const bal0 = await t0.balanceOf(walletAddr);
  const bal1 = await t1.balanceOf(walletAddr);

  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (±${symmetricPct}%)`);
  console.log(`  ${symbol.split('/')[0]} balance: ${formatUnits(bal0, decimals0)}`);
  console.log(`  ${symbol.split('/')[1]} balance: ${formatUnits(bal1, decimals1)}`);

  const amount0Desired = bal0;
  const amount1Desired = bal1;
  const slippagePct = BigInt(config.slippagePct);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + config.deadlineSec);

  // Detailed liquidity debug
  const sqrtPX96 = BigInt(sqrtPriceX96);
  const sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, sqrtPX96);
  const sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, sqrtPX96);
  const Q96 = 1n << 96n;
  const L0_debug = amount0Desired * sqrtPX96 * sqrtPbX96 / ((sqrtPbX96 - sqrtPX96) * Q96);
  const L1_debug = amount1Desired * Q96 / (sqrtPX96 - sqrtPaX96);
  const expectedLiquidity = L0_debug < L1_debug ? L0_debug : L1_debug;
  // Back-calculate implied amounts from L
  let implied0 = amount0Desired, implied1 = amount1Desired;
  if (expectedLiquidity === L0_debug) {
    implied1 = expectedLiquidity * (sqrtPX96 - sqrtPaX96) / Q96;
  } else {
    implied0 = expectedLiquidity * (sqrtPbX96 - sqrtPX96) * Q96 / (sqrtPX96 * sqrtPbX96);
  }
  // FIX (jangan hilang lagi!): amountMin dari IMPLIED (jumlah nyata dipakai liquidity L),
  // BUKAN dari amountDesired mentah -- kalau salah satu sisi jadi pembatas, amountMin
  // dari input penuh selalu > implied amount, bikin mint SELALU revert "Price slippage check".
  // TERBUKTI dengan tx nyata: mint #125115 sukses SETELAH fix ini diterapkan.
  const amount0Min = implied0 - (implied0 * slippagePct) / 100n;
  const amount1Min = implied1 - (implied1 * slippagePct) / 100n;
  console.log(`  sqrtPaX96: ${sqrtPaX96}`);
  console.log(`  sqrtPbX96: ${sqrtPbX96}`);
  console.log(`  sqrtPX96:  ${sqrtPX96}`);
  console.log(`  amount0 (${symbol.split('/')[0]}): ${formatUnits(amount0Desired, decimals0)}`);
  console.log(`  amount1 (${symbol.split('/')[1]}): ${formatUnits(amount1Desired, decimals1)}`);
  console.log(`  L0 = amount0·sqrtP·sqrtPb / ((sqrtPb-sqrtP)·Q96) = ${L0_debug}`);
  console.log(`  L1 = amount1·Q96 / (sqrtP-sqrtPa) = ${L1_debug}`);
  console.log(`  L = min(L0, L1) = ${expectedLiquidity}  (${expectedLiquidity === L0_debug ? 'L0-constrained' : 'L1-constrained'})`);
  console.log(`  Implied amount0 used: ${formatUnits(implied0, decimals0)}`);
  console.log(`  Implied amount1 used: ${formatUnits(implied1, decimals1)}`);

  if (!wallet) {
    console.log('  DRY-RUN: no wallet, skipping mint.');
    return { token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, expectedLiquidity };
  }

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, wallet);

  const allowance0 = await t0.allowance(wallet.address, V3.nfpm);
  if (allowance0 < amount0Desired) {
    console.log(`  Approving ${symbol.split('/')[0]} for V3 NFPM...`);
    const tx = await t0.approve.populateTransaction(V3.nfpm, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
    console.log(`  Approve tx: ${app.hash}`);
  }
  const allowance1 = await t1.allowance(wallet.address, V3.nfpm);
  if (allowance1 < amount1Desired) {
    console.log(`  Approving ${symbol.split('/')[1]} for V3 NFPM...`);
    const tx = await t1.approve.populateTransaction(V3.nfpm, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
    console.log(`  Approve tx: ${app.hash}`);
  }

  const mintParams = {
    token0, token1, fee,
    tickLower, tickUpper,
    amount0Desired, amount1Desired,
    amount0Min, amount1Min,
    recipient: wallet.address,
    deadline,
  };
  const pop = await nfpm.mint.populateTransaction(mintParams);
  const gas = await wallet.estimateGas(pop);
  console.log(`  Estimated gas: ${gas}`);
  const tx = await wallet.sendTransaction(pop);
  console.log(`  Mint tx: ${tx.hash}`);
  const receipt = await tx.wait();

  const nfpmLogs = receipt.logs.filter(l => l.address.toLowerCase() === V3.nfpm.toLowerCase());
  let tokenId = null;
  for (const log of nfpmLogs) {
    if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }
  console.log(`  Token ID: ${tokenId}`);

  const position = { dex: 'V3', pool: symbol, tokenId: tokenId?.toString(),
    token0, token1, fee, entryTick, tickLower, tickUpper,
    amount0: amount0Desired.toString(), amount1: amount1Desired.toString(),
    block: receipt.blockNumber, tx: tx.hash, ts: Date.now() };
  const state = loadState();
  state.positions.push(position);
  saveState(state);

  console.log('  ✅ V3 position created');
  return position;
}

// Deposit V4 position via modifyLiquiditiesWithoutUnlock
// Uses actions: MINT_POSITION=2
export async function depositV4(provider, wallet, config, poolInfo = null) {
  const useDefault = !poolInfo;
  const token0 = useDefault ? CASHCAT : poolInfo.currency0;
  const token1 = useDefault ? USDG : poolInfo.currency1;
  const symbol = useDefault ? LP_V4_CASHCAT_USDG.symbol
    : `${poolInfo.baseToken?.symbol || '?'}/${poolInfo.quoteToken?.symbol || '?'}`;
  const decimals0 = useDefault ? 18 : (poolInfo.decimals0 || 18);
  const decimals1 = useDefault ? 6 : (poolInfo.decimals1 || 6);
  const poolKey = useDefault ? LP_V4_CASHCAT_USDG.key : {
    currency0: poolInfo.currency0, currency1: poolInfo.currency1,
    fee: poolInfo.fee, tickSpacing: poolInfo.tickSpacing,
    hooks: poolInfo.hooks || '0x0000000000000000000000000000000000000000',
  };

  console.log(`\n=== V4 ${symbol} Deposit ===`);
  if (useDefault && !config.enableV4CashcatUsdg) { console.log('  SKIPPED (disabled in config)'); return null; }

  const [sqrtPriceX96BN, currentTickBN] = await getV4Slot0(provider, poolKey);
  const sqrtPriceX96 = BigInt(sqrtPriceX96BN);
  const currentTick = Number(currentTickBN);
  const tickSpacing = poolKey.tickSpacing;
  const { tickLower, tickUpper } = computeTickRange(currentTick, config.rangeSymmetricPct, tickSpacing);

  const t0 = new Contract(token0, ERC20_ABI, provider);
  const t1 = new Contract(token1, ERC20_ABI, provider);
  const walletAddr = wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE);
  const bal0 = await t0.balanceOf(walletAddr);
  const bal1 = await t1.balanceOf(walletAddr);
  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (±${config.rangeSymmetricPct}%)`);
  console.log(`  ${symbol.split('/')[0]} balance: ${formatUnits(bal0, decimals0)}`);
  console.log(`  ${symbol.split('/')[1]} balance: ${formatUnits(bal1, decimals1)}`);

  const keyTuple = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];

  const MINT_POSITION = 2;
  let liquidity;
  let sqrtPaX96;
  let sqrtPbX96;
  const Q96 = 1n << 96n;

  if (sqrtPriceX96 === 0n) {
    console.log('  V4 pool is uninitialized (no liquidity yet). First LP uses both tokens at initial sqrt(1)·2^96.');
    const initialSqrtP = 1n << 96n;
    sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, initialSqrtP);
    sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, initialSqrtP);
    const L0 = bal0 * initialSqrtP * sqrtPbX96 / ((sqrtPbX96 - initialSqrtP) * Q96);
    const L1 = bal1 * Q96 / (initialSqrtP - sqrtPaX96);
    liquidity = L0 < L1 ? L0 : L1;
    console.log(`  L0 (${symbol.split('/')[0]}-bound): ${L0}`);
    console.log(`  L1 (${symbol.split('/')[1]}-bound): ${L1}`);
    console.log(`  L = ${liquidity}`);
  } else {
    sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, sqrtPriceX96);
    sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, sqrtPriceX96);
    const L0 = bal0 * sqrtPriceX96 * sqrtPbX96 / ((sqrtPbX96 - sqrtPriceX96) * Q96);
    const L1 = bal1 * Q96 / (sqrtPriceX96 - sqrtPaX96);
    liquidity = L0 < L1 ? L0 : L1;
    const bindingSide = L0 < L1 ? symbol.split('/')[0] : symbol.split('/')[1];
    let expected0 = bal0, expected1 = bal1;
    if (liquidity === L0) {
      expected1 = liquidity * (sqrtPriceX96 - sqrtPaX96) / Q96;
    } else {
      expected0 = liquidity * (sqrtPbX96 - sqrtPriceX96) * Q96 / (sqrtPriceX96 * sqrtPbX96);
    }
    console.log(`  L0 (${symbol.split('/')[0]}-bound): ${L0}`);
    console.log(`  L1 (${symbol.split('/')[1]}-bound): ${L1}`);
    console.log(`  L = ${liquidity} (${bindingSide}-constrained)`);
    console.log(`  Expected ${symbol.split('/')[0]} used: ${formatUnits(expected0, decimals0)}`);
    console.log(`  Expected ${symbol.split('/')[1]} used: ${formatUnits(expected1, decimals1)}`);
  }
  const amount0Max = (1n << 128n) - 1n;
  const amount1Max = (1n << 128n) - 1n;
  const mintParams = abi.encode(
    ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [keyTuple, tickLower, tickUpper, liquidity, amount0Max, amount1Max, walletAddr, '0x']
  );
  const settlePairParams = abi.encode(
    ['address', 'address'],
    [poolKey.currency0, poolKey.currency1]
  );
  const takePairParams = abi.encode(
    ['address', 'address', 'address'],
    [poolKey.currency0, poolKey.currency1, walletAddr]
  );

  const SETTLE_PAIR = 0x0d;
  const TAKE_PAIR = 0x11;
  const actions = new Uint8Array([MINT_POSITION, SETTLE_PAIR, TAKE_PAIR]);
  const paramsList = [mintParams, settlePairParams, takePairParams];

  if (!wallet) {
    console.log('  DRY-RUN: no wallet, skipping mint.');
    return { key: poolKey, tickLower, tickUpper, entryTick: currentTick, liquidity: liquidity.toString(), actions: Array.from(actions) };
  }

  const nfpm = new Contract(V4_NFPM, V4_NFPM_ABI, wallet);
  const permit2 = new Contract(V4.permit2, [
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
  ], wallet);

  // Approve NFPM + Permit2 for BOTH tokens
  for (const [token, decimals] of [[token0, decimals0], [token1, decimals1]]) {
    const label = token === token0 ? symbol.split('/')[0] : symbol.split('/')[1];
    const t = new Contract(token, ERC20_ABI, wallet);
    const bal = await t.balanceOf(wallet.address);
    if (bal === 0n) continue;
    const erc20Allow = await t.allowance(wallet.address, V4.permit2);
    if (erc20Allow < bal) {
      console.log(`  ${label} ERC20 → Permit2 allowance: ${formatUnits(erc20Allow, decimals)} (need ${formatUnits(bal, decimals)})`);
      console.log(`  Approving ${label} ERC20 for Permit2...`);
      const tx = await t.approve.populateTransaction(V4.permit2, MaxUint256);
      const app = await wallet.sendTransaction(tx);
      console.log(`    Tx: ${app.hash}`);
      await app.wait();
      console.log(`    ✅ ERC20 approve done`);
    } else {
      console.log(`  ${label} ERC20 → Permit2 allowance: ${formatUnits(erc20Allow, decimals)} (OK)`);
    }
    const uint160Max = (1n << 160n) - 1n;
    const uint48Max = (1n << 48n) - 1n;
    const [p2Allow, p2Expiration] = await permit2.allowance.staticCall(wallet.address, token, V4_NFPM);
    const now = BigInt(Math.floor(Date.now()/1000));
    const expired = p2Expiration <= now;
    console.log(`  ${label} Permit2 → NFPM: amount=${p2Allow}, expiration=${p2Expiration}${expired ? ' (EXPIRED)' : ' (OK)'}`);
    if (p2Allow < uint160Max || expired) {
      console.log(`  ${label} Permit2 re-approving...`);
      const pmApp = await permit2.approve.populateTransaction(token, V4_NFPM, uint160Max, uint48Max);
      const tx = await wallet.sendTransaction(pmApp);
      console.log(`    Tx: ${tx.hash}`);
      await tx.wait();
      console.log(`    ✅ Permit2 approve done`);
      // Verify after approve
      const [p2NewAllow, p2NewExp] = await permit2.allowance.staticCall(wallet.address, token, V4_NFPM);
      const stillExpired = p2NewExp <= now;
      console.log(`  ${label} Permit2 → NFPM (after approve): amount=${p2NewAllow}, expiration=${p2NewExp}${stillExpired ? ' (STILL EXPIRED!)' : ' (OK)'}`);
      if (stillExpired) throw new Error(`${label} Permit2 allowance STILL expired after re-approve — tx might have succeeded but expiration not updated`);
    }
  }

  const unlockData = abi.encode(
    ['bytes', 'bytes[]'],
    [actions, paramsList]
  );
  const deadline = BigInt(Math.floor(Date.now()/1000) + 1800); // 30 menit
  const pop = await nfpm.modifyLiquidities.populateTransaction(unlockData, deadline);
  try {
    const tx = await wallet.sendTransaction(pop);
    console.log(`  Mint tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Status: ${receipt.status === 1 ? 'OK' : 'FAIL'}`);

    // Extract tokenId from Transfer event (same ERC-721 pattern as V3)
    let tokenId = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === V4_NFPM.toLowerCase() &&
          log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
          log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        tokenId = BigInt(log.topics[3]).toString();
        break;
      }
    }
    console.log(`  Token ID: ${tokenId}`);

    const position = { dex: 'V4', pool: symbol, tokenId, entryTick: currentTick, tickLower, tickUpper,
      currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks, poolId: computeV4PoolId(poolKey),
      liquidity: liquidity.toString(), block: receipt.blockNumber, tx: tx.hash, ts: Date.now() };
    const state = loadState();
    state.positions.push(position);
    saveState(state);

    return position;
  } catch (e) {
    console.log(`  Tx failed: ${e.shortMessage || e.message}`);
    const raw = e.data || e.info?.error?.data || e.error?.data;
    if (raw && raw !== '0x') {
      const sel = raw.slice(0, 10);
      const known = ERROR_MAP[sel];
      if (known) console.log(`  Error: ${known}`);
      else console.log(`  Revert data: ${raw.slice(0, 74)}`);
    }
    return null;
  }
}

// ===== GOVERNANCE PRE-CHECK =====
// Validates deposit eligibility BEFORE any swap/tx:
//   1. MAX POSITIONS: cannot exceed MAX_ACTIVE_POSITIONS
//   2. TOKEN DEDUP: same base token cannot be in multiple positions
//   3. OVERRIDE: FORCE_OPEN=1 skips all checks
async function checkGovernance(config) {
  const forceOpen = process.env.FORCE_OPEN === '1';
  if (forceOpen) {
    console.log('  FORCE_OPEN=1 — melewati semua governance check.');
    return;
  }

  const state = loadState();
  const existing = state.positions || [];
  const activeCount = existing.length;

  console.log(`\n=== Governance Pre-Check ===`);
  console.log(`  Posisi aktif di state: ${activeCount}`);
  console.log(`  Batas maksimal: ${MAX_ACTIVE_POSITIONS}`);

  if (activeCount >= MAX_ACTIVE_POSITIONS) {
    console.log(`  ❌ BLOKIR: ${activeCount} posisi (batas: ${MAX_ACTIVE_POSITIONS}).`);
    console.log(`  Tutup salah satu dulu, atau set FORCE_OPEN=1 untuk override manual.`);
    process.exit(0);
  }

  // Proposed unique tokens from enabled config
  const proposedSet = new Set();
  if (config.enableV3CashcatWeth) proposedSet.add(LP_V3_CASHCAT_WETH.token0.toLowerCase());
  if (config.enableV4CashcatUsdg) proposedSet.add(LP_V4_CASHCAT_USDG.key.currency0.toLowerCase());

  for (const pos of existing) {
    if (pos.dex !== 'V3' && pos.dex !== 'V4') continue;
    const ut = positionUniqueToken(pos);
    if (!ut) continue;
    if (proposedSet.has(ut.toLowerCase())) {
      console.log(`  ❌ BLOKIR: token ${ut.slice(0,10)}... sudah dipakai di posisi #${pos.tokenId} (${pos.pool || pos.dex}).`);
      console.log(`  Prinsip: 1 pair terbaik per token, jangan dobel.`);
      console.log(`  Set FORCE_OPEN=1 untuk override manual.`);
      process.exit(0);
    }
  }

  console.log(`  ✅ Governance check passed.`);
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

  console.log('\n=== LP DEPOSIT ========================================');
  console.log('Config:');
  console.log(`  V3 CASHCAT/WETH: ${config.enableV3CashcatWeth ? 'ENABLED' : 'DISABLED'} (CASHCAT: ${config.lpAmountEthCashcat} ETH | WETH: ${config.lpAmountEthWeth} ETH)`);
  console.log(`  V4 CASHCAT/USDG: ${config.enableV4CashcatUsdg ? 'ENABLED' : 'DISABLED'} (USDG: ${config.lpAmountEthUsdg || 0} ETH)`);
  console.log(`  Order: V4 → V3 (V4 first, V3 pakai sisa CASHCAT)`);
  console.log(`  Range: ±${config.rangeSymmetricPct}% (symmetric)`);
  console.log(`  Slippage: ${config.slippagePct}%`);

  // Governance pre-check: blokir sebelum swap ETH terjadi
  await checkGovernance(config);

  const resultV3 = wallet ? null : { token0: CASHCAT, token1: WETH, fee: 10000 };
  const resultV4 = wallet ? null : { key: LP_V4_CASHCAT_USDG.key };

  if (process.env.SKIP_SWAP !== '1') {
    console.log('\n--- Step 1: Swap ETH → CASHCAT (if needed) ---');
    const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
    const bal = await cashcat.balanceOf(wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE));
    console.log(`  Current CASHCAT balance: ${formatEther(bal)}`);
    if (bal === 0n && wallet) {
      console.log('  ⚠️ No CASHCAT balance. Run lp_swap.js first or set SKIP_SWAP=1.');
      process.exit(1);
    }
  }

  // Step 2: Deposit V4 FIRST (butuh CASHCAT lebih banyak, dapat prioritas)
  let posV4 = null;
  if (config.enableV4CashcatUsdg) {
    posV4 = await depositV4(provider, wallet, config);
  }

  // Step 3: Deposit V3 SECOND (pakai sisa CASHCAT, toleran terhadap kurang)
  let posV3 = null;
  if (config.enableV3CashcatWeth) {
    posV3 = await depositV3(provider, wallet, config);
  }

  console.log('\n=== RESULTS ===');
  if (posV4) console.log(`V4: currency0=${posV4.key?.currency0?.slice(0,10)||'?'} currency1=${posV4.key?.currency1?.slice(0,10)||'?'}`);
  if (posV3) console.log(`V3: token0=CASHCAT token1=WETH fee=10000 tickL=${posV3.tickLower} tickU=${posV3.tickUpper}`);

  if (!wallet) console.log('\nDRY-RUN complete. To execute: DRY=0 PRIVATE_KEY=0x.. node lp_deposit.js');
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
}
