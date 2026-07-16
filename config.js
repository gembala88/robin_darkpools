// config.js — all values VERIFIED on-chain (Robinhood Chain, chainId 4663)
// Discovery done via RobinFun frontend bundle + on-chain eth_call / eth_getLogs.

import fs from 'node:fs';

// ===== USER CONFIG (Meridian-style: safe to edit, no secrets) =====
let _uc = {};
try {
  _uc = JSON.parse(fs.readFileSync(new URL('./user-config.json', import.meta.url), 'utf8'));
} catch {}
function _require(key, val) {
  if (val === undefined || val === null) throw new Error(`user-config.json: required key "${key}" not found`);
  return val;
}
export const UC = (key) => {
  const parts = key.split('.');
  let val = _uc;
  for (const p of parts) {
    if (val === undefined || val === null) break;
    val = val[p];
  }
  return _require(key, val);
};
export const UCW = (key) => { const w = _uc.scoreWeights; return _require('scoreWeights.'+key, w ? w[key] : undefined); };
export const UCS = (key) => { const s = _uc.safety; return _require('safety.'+key, s ? s[key] : undefined); };

export const CHAIN = {
  id: 4663,
  name: 'robinhood',
  // Public RPC hostname. NOTE: robinhood.com is DNS-blocked by many ID ISPs
  // (Kominfo). provider.js pins the Cloudflare origin IP + correct SNI so it
  // works behind the block. Override with RPC_URL env to use a paid provider.
  rpcHost: 'rpc.mainnet.chain.robinhood.com',
  // Cloudflare origin IPs (customer-origin.offchainlabs.com). Refreshed via DoH
  // at startup; these are fallbacks.
  rpcIps: ['104.20.46.209', '172.66.147.70'],
  explorer: 'https://robinhoodchain.blockscout.com',
};

export const TOKEN = {
  address: '0x45c2a2462e4ffc37e9698b46361f0f6444544663', // RH6900
  symbol: 'RH6900',
  decimals: 18,
};

// RobinFun bonding-curve router that currently MANAGES this token (factory V5).
// buy()/sell()/quoteBuy()/quoteSell() all live here. Verified: curves(token)
// returns a live curve, token is 36.9% to graduation (NOT graduated yet).
export const CURVE = {
  address: '0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d',
  buyFeeBps: 100n,  // RobinFun charges 1% on buy
  sellFeeBps: 100n, // and 1% on sell (already reflected inside quoteBuy/quoteSell)
};

// Uniswap V4 infra on Robinhood Chain (from developers.uniswap.org deployments).
export const V4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

// REAL PoolKeys decoded from the PoolManager `Initialize` event. Both are
// RH6900/ETH V4 pools with currency0 = native ETH, currency1 = RH6900, no hooks.
// The bot quotes the SELL across every pool and routes to the best one.
export const POOLS = [
  {
    name: 'v4-25pct',
    id: '0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362',
    key: {
      currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x45c2a2462e4ffc37e9698b46361f0f6444544663',
      fee: 250000,      // 25% LP fee
      tickSpacing: 5000,
      hooks: '0x0000000000000000000000000000000000000000',
    },
  },
  {
    name: 'v4-10pct',
    id: '0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326',
    key: {
      currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0x45c2a2462e4ffc37e9698b46361f0f6444544663',
      fee: 100000,      // 10% LP fee
      tickSpacing: 2000,
      hooks: '0x0000000000000000000000000000000000000000',
    },
  },
];

// ===== V3 UNISWAP (Official Uniswap V3 deployment on Robinhood Chain) =====
// Addresses from developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
export const V3 = {
  factory:      '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  nfpm:         '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  quoterV2:     '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  nftDescriptor:'0x6f84dae9c064ff453e5c8af51efb819f8f610225',
};
// ===== V4 NFPM (Verified "PositionManager" on Blockscout) =====
export const V4_NFPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7';

// ===== LP POOL DEFINITIONS (for deposit/withdraw) =====
// V3: CASHCAT/WETH 1% — verified: pool.factory() = V3 factory
export const LP_V3_CASHCAT_WETH = {
  token0: '0x020bfc650a365f8bb26819deaabf3e21291018b4', // CASHCAT
  token1: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
  fee: 10000, // 1%
  pool: '0xa70fc67c9f69da90b63a0e4c05d229954574e313',
  symbol: 'CASHCAT/WETH-1%',
};

// V4: CASHCAT/USDG 0.269% — top V4 pool (DexScreener: $1.2M TVL, $15M/24h vol)
// PoolKey: currency0=CASHCAT (lower addr), currency1=USDG, fee=2690, tickSpacing=54, hooks=0x0
// poolId=0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b
export const LP_V4_CASHCAT_USDG = {
  key: {
    currency0: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    fee: 2690,
    tickSpacing: 54,
    hooks: '0x0000000000000000000000000000000000000000',
  },
  poolId: '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b',
  symbol: 'CASHCAT/USDG-0.269%',
};

// backward-compat: first pool
export const POOL_KEY = POOLS[0].key;
export const POOL_ID = POOLS[0].id;

// Native ETH pseudo-address used by the curve/V4 for the ETH side.
export const NATIVE = '0x0000000000000000000000000000000000000000';
