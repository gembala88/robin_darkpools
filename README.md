# 🤖 RobinArb — Autonomous LP & Arbitrage System for Robinhood Chain

> **While most LP managers on Robinhood Chain check their positions by hand, this one doesn't sleep.**

A fully autonomous liquidity-provision and arbitrage system for **Robinhood Chain** (chainId `4663`) — discovers pools, scores candidates, opens positions, and closes them again, with zero manual clicking.

[![Chain](https://img.shields.io/badge/chain-Robinhood%20(4663)-green)]()
[![Automation](https://img.shields.io/badge/mode-fully%20autonomous-blue)]()
[![Safety](https://img.shields.io/badge/pre--flight-simulated-orange)]()

---

## 🧠 Why this is different

Most LP bots on new chains are **manual dashboards** — you still have to spot a pool, decide, click, and watch it yourself. This system replaces every one of those steps:

| Manual LP management | This system |
|---|---|
| You scan DexScreener yourself | Auto-discovers pools from **on-chain events** (V3 factory + V4 `Initialize`), not just keyword search — tracks 1000+ pool candidates |
| You eyeball "is this safe?" | Multi-gate scoring: TVL, momentum trend, **LP concentration (HHI)**, GMGN security check |
| You hope it's not a honeypot | **Self-tests every candidate** — simulates a buy→sell round-trip via on-chain quoter *before* ever opening a position |
| You watch the chart for exits | Auto-closes on **stop-loss** (impermanent-loss threshold) **or trailing take-profit** (arms at a gain %, locks in on pullback) |
| You risk wasted gas on failed txs | Every state-changing transaction is **simulated first** (`eth_call`) — a doomed tx never gets broadcast |
| You manage one position at a time | Governance layer: max concurrent positions, per-token cooldown, dedup by underlying asset |

---

## 🏗️ Architecture

┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐
│ lp_screener.js │────▶│ lp_auto_open.js │────▶│ lp_deposit.js │
│ discover+score │ │ gate checks │ │ mint position │
└─────────────────┘ └──────────────────┘ └─────────────────┘
│
┌─────────────────┐ ┌──────────────────┐ ▼
│ telegram_bot.js │◀────│ lp_monitor.js │◀─────── (position live)
│ /status /pause │ │ IL + TP watch │
└─────────────────┘ └──────────────────┘
│
▼
lp_withdraw.js
(auto-close, simulated pre-flight)

A separate **atomic arbitrage engine** (`arb.js`) also runs in parallel, trading the spread between a token's bonding curve and its live Uniswap V4 pool — profit-or-revert in a single transaction, so a missed window costs only gas, never inventory.

---

## 🚪 The gate a candidate must clear before a real position opens

1. **Trend** — pool value must be genuinely *rising*, not just big
2. **Score ≥ threshold** — composite of TVL, volume, swap count, age, price stability
3. **HHI concentration** — rejects pools dominated by a single whale wallet
4. **GMGN security check** — flags known-risky contracts
5. **Honeypot self-test** — quotes a buy then a sell; if the sell reverts or returns <50%, blocked
6. **Swap-route check** — token must have a real path to/from ETH
7. **Governance** — position limit, per-token cooldown, no duplicate underlying assets

Only after *all seven* pass does real capital move — and even then, the mint transaction is simulated once more immediately before broadcast.

---

## 🚀 Quick Start

```bash
git clone https://github.com/gembala88/robin_darkpools.git
cd robin_darkpools
npm install
cp .env.example .env
```

Fill in `.env`:
```env
PRIVATE_KEY=0x...              # wallet that holds trading capital
LP_RPC_URL=...                 # any Robinhood Chain RPC (public one works, private is faster)
TELEGRAM_BOT_TOKEN=...         # optional but recommended — get one from @BotFather
TELEGRAM_CHAT_ID=...
```

Configure risk parameters in `user-config.json`:
```json
{
  "lp": {
    "ilExitThresholdPct": 10,      // stop-loss trigger
    "depositMode": "in-range",     // or "single-side-eth" for a defensive entry
    "maxPositions": 3
  }
}
```

Run the pieces (each is a long-running process — use `pm2` for 24/7):
```bash
node lp_screener.js      # discovery + scoring + auto-open (the brain)
node lp_monitor.js       # watches open positions, auto-closes
node telegram_bot.js     # /status /positions /pause /resume from your phone
```

Or all at once with pm2:
```bash
pm2 start lp_screener.js lp_monitor.js telegram_bot.js
pm2 save && pm2 startup
```

### Telegram commands
| Command | What it does |
|---|---|
| `/status` | Auto-open state, position count, wallet balance |
| `/positions` | List active positions with tick range |
| `/pause` | Freeze new position opens (existing ones still monitored) |
| `/resume` | Re-enable |

---

## ⚠️ Honest notes

- This is **experimental software** running on a very young chain — expect edge cases.
- Every gate above *reduces* risk; none of them *eliminate* it. Impermanent loss and rug pulls are real possibilities on any AMM.
- Position sizes default small (0.01 ETH) on purpose — this is a discovery/research tool first, not a guaranteed-yield machine.
- Read `lp_auto_open.js` and `lp_monitor.js` before pointing real capital at it. Understand what you're running.

---

## 📂 Key files

| File | Purpose |
|---|---|
| `lp_screener.js` | Pool discovery (DexScreener + on-chain V3/V4 registry), scoring, auto-open orchestration |
| `lp_auto_open.js` | The 7-gate check + generic swap/deposit execution for any token pair |
| `lp_monitor.js` | Position watch loop — IL stop-loss, trailing take-profit, periodic Telegram reports |
| `lp_deposit.js` / `lp_withdraw.js` | Low-level mint/withdraw with pre-flight transaction simulation |
| `arb.js` | Standalone atomic curve↔V4 arbitrage bot |
| `telegram_bot.js` | Remote control via Telegram commands |
| `v4_pool_scanner.js` | Incremental on-chain scanner building a full V4 pool registry |

---

## 🛡️ Safety

- `.env` is gitignored — never commit it.
- Arb execution is atomic (profit-or-revert) — a missed window costs only gas.
- Every LP mint/withdraw/swap is simulated (`eth_call`) before broadcast.
- Governance caps concurrent exposure and prevents duplicate-token stacking.

---

🇮🇩 Versi Bahasa Indonesia: **[README.id.md](README.id.md)**