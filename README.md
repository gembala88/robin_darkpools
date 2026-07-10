# RobinArb

> 🇮🇩 Versi Bahasa Indonesia: [README.id.md](README.id.md)

Atomic arbitrage bot for **Robinhood Chain** (chainId 4663): trades the gap between
a token's **RobinFun bonding curve** and its **Uniswap V4** pool, in a single
profit-or-revert transaction.

- **Direction A** — buy on the curve → sell on V4 (fires when V4 is pumped above the curve)
- **Direction B** — buy on V4 → sell on the curve (fires when V4 is dumped below the curve)

The bot auto-discovers every token that has both an active curve and a liquid V4
pool, watches them event-driven, sizes each trade optimally, and only fires when the
net edge (after the 1% curve fee, the V4 pool fee, slippage and gas) clears the gate.

## How it works — operator playbook

You create the arbitrage venue; the bot captures it automatically. Steps:

1. **Find a curve token.** Browse tokens on **https://robinfun.live** and pick one
   with at least **10% bonding progress** — enough curve depth to trade against.

2. **Create its Uniswap V4 pool manually.** Add a pool for that token on Uniswap V4
   with a **25% base fee**, and set the **initial price equal to the token's current
   bonding-curve price** (so the pool starts aligned with the curve — no free loss).

3. **Trigger / seed the pool.** Copy the token's **contract address**, paste it into
   **https://trigerpool.vercel.app**, connect your wallet, leave the trigger settings
   on **default**, and click **Swap**. This initializes the pool and emits its first
   on-chain Swap.

4. **The bot takes over — no manual input needed.** RobinArb's real-time listener
   watches the Uniswap V4 PoolManager `Initialize` event. The moment your new pool is
   created it is **added to the watchlist automatically** (also persisted, and the
   6-hourly `npm run scan` backstops it) — you never edit the bot to add a token.
   From then on it quotes both directions and fires an atomic trade whenever the pool
   price diverges from the curve past the fees.

> TL;DR: pick a ≥10% bonded RobinFun token → make its 25% V4 pool at the curve price
> → trigger it once → the bot detects it live and arbs it.

## How it trades (atomic)

`contracts/ArbExecutor.sol` holds the working capital and does buy+sell in **one tx**
that **reverts unless the contract's ETH balance grows by `minProfit`** — so a closed
window costs only gas, never an inventory loss. The owner wallet only pays gas.

- `curveToV4(token, ethIn, minTokensOut, key, minEthOut, minProfit)` — dir A
- `v4ToCurve(token, ethIn, minTokensOut, key, minEthOut, minProfit)` — dir B
- `forceCurveToV4 / forceV4ToCurve` — owner-only manual override (no profit guard, for testing)
- `withdraw / rescueToken / setOwner` — owner only

## Setup

```bash
npm install
cp .env.example .env      # fill PRIVATE_KEY, EXEC_RPC_URL, Telegram; leave EXECUTOR_ADDR blank for now
```

RPC: set `EXEC_RPC_URL` to a private Alchemy/dRPC endpoint (used for trade execution).
Monitoring falls back to the public Robinhood RPC with a **built-in DNS-block bypass**
(Cloudflare IP pin + DoH) — works behind ISPs that block `*.robinhood.com`, no VPN.

## Deploy + fund the contract

```bash
npm run build:contract                 # compile -> build/ArbExecutor.json
npm run deploy                         # deploy ArbExecutor, prints the address
# put the printed address in .env as EXECUTOR_ADDR, then:
AMOUNT_ETH=0.006 npm run deposit        # fund working capital (>= MAX_SIZE_ETH)
```

## Withdraw

```bash
npm run withdraw                       # withdraw everything to the owner wallet
LEAVE_ETH=0.006 npm run withdraw        # withdraw all but 0.006 (keep trading capital)
AMOUNT_ETH=0.01 npm run withdraw        # withdraw an exact amount
```

## Run

```bash
npm run scan            # discover arbitrable tokens -> watchlist.json
npm run monitor        # dry-run: watch spreads, no trading
LIVE=1 npm run live     # live atomic trading (needs funded contract + EXECUTOR_ADDR)
npm run snapshot       # one-off econ snapshot across the watchlist
```

24/7 with pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs robinarb
# refresh the watchlist periodically (cron): npm run scan && pm2 restart robinarb
```

## Files

| File | Purpose |
|---|---|
| `arb.js` | main bot: discover, quote both directions, optimal size, fire atomic |
| `scanner.js` | on-chain discovery of curve+V4 tokens -> watchlist.json |
| `snapshot.js` | econ snapshot across the watchlist |
| `discover.mjs` | verify curve state / PoolKey / V4 liquidity on-chain |
| `provider.js` | ethers provider with DNS-block bypass + concurrency/backoff |
| `config.js` | verified on-chain addresses (factory, V4 infra, PoolKeys) |
| `abis.js` | curve ABI + Universal Router V4 swap encoder |
| `telegram.js` | real-time trade notifications |
| `contracts/ArbExecutor.sol` | atomic profit-or-revert executor |
| `deploy.js` / `deposit.js` / `withdraw.js` | contract lifecycle |
| `forcetest.js` / `atomictest.js` | executor validation (owner-only force calls) |

## Config knobs (.env)

| var | meaning |
|---|---|
| `LIVE` | `1` = trade, `0` = monitor |
| `MIN_SIZE_ETH` / `MAX_SIZE_ETH` | trade size bounds |
| `MIN_PROFIT_BPS` | required net edge after fees + gas |
| `GRID_POINTS` | probe sizes per direction |
| `POLL_MS` / `EVENT_POLL_MS` | fallback poll / Swap-event cadence |
| `EXEC_RPC_URL` | private execution RPC (Alchemy) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | notifications |

## Safety

- `.env` (private key + private RPC) is gitignored — never commit it.
- Atomic execution can't lose on a trade: it reverts unless profitable.
- Working capital lives in the contract; withdraw anytime (owner only).
