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

// Get current tick and sqrtPriceX96 from V4 pool
async function getV4Slot0(provider) {
  const poolId = computeV4PoolId(LP_V4_CASHCAT_USDG.key);
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
function sqrtPriceAtTick(tick, currentTick, currentSqrtPriceX96) {
  const diff = tick - currentTick;
  if (diff === 0) return currentSqrtPriceX96;
  const Q96 = 1n << 96n;
  const ratio = Math.pow(1.0001, diff / 2);
  return currentSqrtPriceX96 * BigInt(Math.round(ratio * Number(Q96))) / Q96;
}

// Compute tick range SYMMETRIC around current tick:
//   tickLower = currentTick - rangePct%
//   tickUpper = currentTick + rangePct%
function computeTickRange(currentTick, symmetricPct, tickSpacing) {
  const halfRangeTicks = Math.floor(Math.log(1 + symmetricPct / 100) / Math.log(1.0001));
  const halfRangeAligned = Math.ceil(halfRangeTicks / tickSpacing) * tickSpacing;
  const tickLower = Math.floor(currentTick / tickSpacing) * tickSpacing - halfRangeAligned;
  const tickUpper = Math.ceil(currentTick / tickSpacing) * tickSpacing + halfRangeAligned;
  return { tickLower, tickUpper };
}

// Two-sided liquidity: min(L0, L1) using standard V3 formula.
// amount0 = CASHCAT, amount1 = WETH.
function computeLiquidity(amount0, amount1, sqrtPriceX96, currentTick, tickLower, tickUpper) {
  const sqrtPX96 = BigInt(sqrtPriceX96);
  const sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, sqrtPX96);
  const sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, sqrtPX96);
  const Q96 = 1n << 96n;
  if (sqrtPX96 <= sqrtPaX96 || sqrtPX96 >= sqrtPbX96) return 0n;
  const L0 = amount0 * sqrtPX96 * sqrtPbX96 / ((sqrtPbX96 - sqrtPX96) * Q96);
  const L1 = amount1 * Q96 / (sqrtPX96 - sqrtPaX96);
  return L0 < L1 ? L0 : L1;
}

async function depositV3(provider, wallet, config) {
  console.log('\n=== V3 CASHCAT/WETH 1% Deposit ===');
  if (!config.enableV3CashcatWeth) { console.log('  SKIPPED (disabled in config)'); return null; }

  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const weth = new Contract(WETH, ERC20_ABI, provider);
  const factory = new Contract(V3.factory, ['function feeAmountTickSpacing(uint24) view returns (int24)'], provider);
  const tickSpacing = Number(await factory.feeAmountTickSpacing(LP_V3_CASHCAT_WETH.fee));
  const symmetricPct = Number(config.rangeSymmetricPct || 15);

  const currentTick = await getV3Tick(provider);
  const entryTick = currentTick;
  const { tickLower, tickUpper } = computeTickRange(currentTick, symmetricPct, tickSpacing);

  const slot0 = await provider.call({ to: LP_V3_CASHCAT_WETH.pool, data: '0x3850c7bd' });
  const [sqrtPriceX96] = AbiCoder.defaultAbiCoder().decode(['uint160'], slot0.slice(0, 66));

  const walletAddr = wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE);
  const cashcatBalance = await cashcat.balanceOf(walletAddr);
  const wethBalance = await weth.balanceOf(walletAddr);

  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (±${symmetricPct}%)`);
  console.log(`  CASHCAT balance: ${formatEther(cashcatBalance)}`);
  console.log(`  WETH balance:    ${formatEther(wethBalance)}`);

  const amount0Desired = cashcatBalance;
  const amount1Desired = wethBalance;
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
  console.log(`  amount0 (CASHCAT): ${formatEther(amount0Desired)}`);
  console.log(`  amount1 (WETH):    ${formatEther(amount1Desired)}`);
  console.log(`  L0 = amount0·sqrtP·sqrtPb / ((sqrtPb-sqrtP)·Q96) = ${L0_debug}`);
  console.log(`  L1 = amount1·Q96 / (sqrtP-sqrtPa) = ${L1_debug}`);
  console.log(`  L = min(L0, L1) = ${expectedLiquidity}  (${expectedLiquidity === L0_debug ? 'L0-constrained (CASHCAT side)' : 'L1-constrained (WETH side)'})`);
  console.log(`  Implied amount0 used: ${formatEther(implied0)} CASHCAT`);
  console.log(`  Implied amount1 used: ${formatEther(implied1)} WETH`);

  if (!wallet) {
    console.log('  DRY-RUN: no wallet, skipping mint.');
    return { token0: CASHCAT, token1: WETH, fee: 10000, tickLower, tickUpper, amount0Desired, amount1Desired, expectedLiquidity };
  }

  const nfpm = new Contract(V3.nfpm, V3_NFPM_ABI, wallet);

  const cashcatAllowance = await cashcat.allowance(wallet.address, V3.nfpm);
  if (cashcatAllowance < amount0Desired) {
    console.log('  Approving CASHCAT for V3 NFPM...');
    const tx = await cashcat.approve.populateTransaction(V3.nfpm, MaxUint256);
    const app = await wallet.sendTransaction(tx);
    await app.wait();
    console.log(`  Approve tx: ${app.hash}`);
  }
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
    entryTick, tickLower, tickUpper, amount0: amount0Desired.toString(), amount1: amount1Desired.toString(),
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
  console.log('\n=== V4 CASHCAT/USDG 0.269% Deposit ===');
  if (!config.enableV4CashcatUsdg) { console.log('  SKIPPED (disabled in config)'); return null; }

  const [sqrtPriceX96BN, currentTickBN] = await getV4Slot0(provider);
  const sqrtPriceX96 = BigInt(sqrtPriceX96BN);
  const currentTick = Number(currentTickBN);
  const tickSpacing = LP_V4_CASHCAT_USDG.key.tickSpacing;
  const { tickLower, tickUpper } = computeTickRange(currentTick, config.rangeSymmetricPct, tickSpacing);

  const cashcat = new Contract(CASHCAT, ERC20_ABI, provider);
  const usdg = new Contract(USDG, ERC20_ABI, provider);
  const walletAddr = wallet?.address || (process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : NATIVE);
  const cashcatBalance = await cashcat.balanceOf(walletAddr);
  const usdgBalance = await usdg.balanceOf(walletAddr);
  console.log(`  Tick current: ${currentTick}`);
  console.log(`  Range: ${tickLower} → ${tickUpper} (±${config.rangeSymmetricPct}%)`);
  console.log(`  CASHCAT balance: ${formatEther(cashcatBalance)}`);
  console.log(`  USDG balance:    ${formatUnits(usdgBalance, 6)}`);

  const poolKey = LP_V4_CASHCAT_USDG.key;
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
    const L0 = cashcatBalance * initialSqrtP * sqrtPbX96 / ((sqrtPbX96 - initialSqrtP) * Q96);
    const L1 = usdgBalance * Q96 / (initialSqrtP - sqrtPaX96);
    liquidity = L0 < L1 ? L0 : L1;
    console.log(`  L0 (CASHCAT-bound): ${L0}`);
    console.log(`  L1 (USDG-bound):    ${L1}`);
    console.log(`  L = ${liquidity}`);
  } else {
    sqrtPaX96 = sqrtPriceAtTick(tickLower, currentTick, sqrtPriceX96);
    sqrtPbX96 = sqrtPriceAtTick(tickUpper, currentTick, sqrtPriceX96);
    const L0 = cashcatBalance * sqrtPriceX96 * sqrtPbX96 / ((sqrtPbX96 - sqrtPriceX96) * Q96);
    const L1 = usdgBalance * Q96 / (sqrtPriceX96 - sqrtPaX96);
    liquidity = L0 < L1 ? L0 : L1;
    const bindingSide = L0 < L1 ? 'CASHCAT' : 'USDG';
    let expected0 = cashcatBalance, expected1 = usdgBalance;
    if (liquidity === L0) {
      expected1 = liquidity * (sqrtPriceX96 - sqrtPaX96) / Q96;
    } else {
      expected0 = liquidity * (sqrtPbX96 - sqrtPriceX96) * Q96 / (sqrtPriceX96 * sqrtPbX96);
    }
    console.log(`  L0 (CASHCAT-bound): ${L0}`);
    console.log(`  L1 (USDG-bound):    ${L1}`);
    console.log(`  L = ${liquidity} (${bindingSide}-constrained)`);
    console.log(`  Expected CASHCAT used: ${formatEther(expected0)}`);
    console.log(`  Expected USDG used:    ${formatUnits(expected1, 6)}`);
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
    return { key: poolKey, tickLower, tickUpper, liquidity: liquidity.toString(), actions: Array.from(actions) };
  }

  const nfpm = new Contract(V4_NFPM, V4_NFPM_ABI, wallet);
  const permit2 = new Contract(V4.permit2, [
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
  ], wallet);

  // Approve NFPM + Permit2 for BOTH tokens
  for (const [token, label, decimals] of [[CASHCAT, 'CASHCAT', 18], [USDG, 'USDG', 6]]) {
    const t = new Contract(token, ERC20_ABI, wallet);
    const bal = await t.balanceOf(wallet.address);
    if (bal === 0n) continue;
    const allowance = await t.allowance(wallet.address, V4.permit2);
    if (allowance < bal) {
      console.log(`  Approving ${label} for Permit2...`);
      const tx = await t.approve.populateTransaction(V4.permit2, MaxUint256);
      const app = await wallet.sendTransaction(tx);
      console.log(`    Tx: ${app.hash}`);
      await app.wait();
      console.log(`    ✅ ERC20 approve done`);
    }
    const uint160Max = (1n << 160n) - 1n;
    const [p2Allow] = await permit2.allowance.staticCall(wallet.address, token, V4_NFPM);
    if (p2Allow < uint160Max) {
      const pmApp = await permit2.approve.populateTransaction(token, V4_NFPM, uint160Max, 0n);
      try {
        const tx = await wallet.sendTransaction(pmApp);
        await tx.wait();
      } catch { /* already approved / race */ }
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

    const position = { dex: 'V4', pool: LP_V4_CASHCAT_USDG.symbol, block: receipt.blockNumber, tx: tx.hash, ts: Date.now() };
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

main().catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
