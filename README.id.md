# RobinArb 🇮🇩

> 🌐 English version: [README.md](README.md)

Bot arbitrase atomic buat **Robinhood Chain** (chainId 4663): ngambil selisih harga
antara **bonding curve RobinFun** sebuah token dan **pool Uniswap V4**-nya, dalam
satu transaksi yang **profit-or-revert**.

- **Arah A** — beli di curve → jual di V4 (nembak pas V4 ke-pump di atas curve)
- **Arah B** — beli di V4 → jual di curve (nembak pas V4 di-dump di bawah curve)

Bot otomatis nyari semua token yang punya curve aktif **dan** pool V4 berlikuiditas,
mantau event-driven, cari ukuran trade optimal, dan cuma nembak kalau net edge
(setelah fee curve 1%, fee pool V4, slippage, dan gas) ngelewatin gate.

## Cara kerja — panduan operator

Lo yang bikin venue arb-nya; bot yang eksekusi otomatis. Langkahnya:

1. **Cari token curve.** Buka **https://robinfun.live**, pilih token yang **bonding-nya
   minimal 10%** — biar curve-nya cukup dalem buat di-trade.

2. **Bikin pool Uniswap V4-nya manual.** Add pool token itu di Uniswap V4 dengan
   **base fee 25%**, dan set **harga awal sama persis dengan harga bonding curve saat
   itu** (biar pool selaras sama curve — gak rugi pas seed).

3. **Trigger / seed pool-nya.** Copy **contract address** token-nya, paste ke
   **https://trigerpool.vercel.app**, connect wallet, biarin setting trigger
   **default**, klik **Swap**. Ini nginisialisasi pool + ngeluarin Swap pertama.

4. **Bot yang ambil alih — tanpa input manual.** Listener real-time RobinArb mantau
   event `Initialize` di PoolManager Uniswap V4. Begitu pool baru lo kebuat, langsung
   **masuk watchlist otomatis** (kesimpen juga, plus `npm run scan` tiap 6 jam sebagai
   cadangan) — lo **gak perlu edit bot** buat nambahin token. Abis itu bot quote 2
   arah dan nembak atomic tiap harga pool divergen dari curve ngelewatin fee.

> Ringkas: pilih token RobinFun bonding ≥10% → bikin pool V4 fee 25% di harga curve →
> trigger sekali → bot deteksi live terus arb sendiri.

## Cara trade-nya (atomic)

`contracts/ArbExecutor.sol` nyimpen modal kerja dan ngelakuin beli+jual dalam **1 tx**
yang **revert kalau saldo kontrak gak naik minimal `minProfit`** — jadi window yang
keburu nutup cuma buang gas, gak pernah nyangkut token. Wallet owner cuma bayar gas.

- `curveToV4(...)` — arah A · `v4ToCurve(...)` — arah B
- `forceCurveToV4 / forceV4ToCurve` — override manual owner (tanpa profit-guard, buat tes)
- `withdraw / rescueToken / setOwner` — owner only

## Setup

```bash
npm install
cp .env.example .env      # isi PRIVATE_KEY, EXEC_RPC_URL, Telegram; EXECUTOR_ADDR nanti
```

RPC: set `EXEC_RPC_URL` ke endpoint privat (Alchemy/dRPC) buat eksekusi trade.
Monitoring fallback ke RPC publik Robinhood dengan **bypass blokir DNS bawaan**
(pin IP Cloudflare + DoH) — jalan di ISP yang blok `*.robinhood.com`, tanpa VPN.

## Deploy + isi modal kontrak

```bash
npm run build:contract                 # compile -> build/ArbExecutor.json
npm run deploy                         # deploy, nampilin address
# masukin address ke .env sebagai EXECUTOR_ADDR, terus:
AMOUNT_ETH=0.006 npm run deposit        # isi modal (>= MAX_SIZE_ETH)
```

## Tarik dana (withdraw)

```bash
npm run withdraw                       # tarik semua ke wallet owner
LEAVE_ETH=0.006 npm run withdraw        # tarik, sisain 0.006 (modal trade)
AMOUNT_ETH=0.01 npm run withdraw        # tarik jumlah tertentu
```

## Jalanin

```bash
npm run scan            # discover token arbitrable -> watchlist.json
npm run monitor        # dry-run: pantau spread, gak trading
LIVE=1 npm run live     # trading atomic live (perlu kontrak ke-fund + EXECUTOR_ADDR)
npm run snapshot       # snapshot ekonomi sekali jalan
```

24/7 pake pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs robinarb
# refresh watchlist berkala (cron): npm run scan && pm2 restart robinarb
```

## Setting (.env)

| var | arti |
|---|---|
| `LIVE` | `1` = trading, `0` = monitor |
| `MIN_SIZE_ETH` / `MAX_SIZE_ETH` | batas ukuran trade |
| `MIN_PROFIT_BPS` | edge net minimal setelah fee + gas |
| `GRID_POINTS` | jumlah ukuran probe per arah |
| `POLL_MS` / `EVENT_POLL_MS` | poll cadangan / cadence event Swap |
| `EXEC_RPC_URL` | RPC eksekusi privat (Alchemy) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | notifikasi |

## Keamanan

- `.env` (private key + RPC privat) di-gitignore — jangan pernah di-commit.
- Eksekusi atomic gak bisa rugi per-trade: revert kalau gak profit.
- Modal kerja ada di kontrak; tarik kapan aja (owner only).
