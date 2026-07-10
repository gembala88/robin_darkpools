// config.js — all values VERIFIED on-chain (Robinhood Chain, chainId 4663)
// Discovery done via RobinFun frontend bundle + on-chain eth_call / eth_getLogs.

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

// backward-compat: first pool
export const POOL_KEY = POOLS[0].key;
export const POOL_ID = POOLS[0].id;

// Native ETH pseudo-address used by the curve/V4 for the ETH side.
export const NATIVE = '0x0000000000000000000000000000000000000000';
