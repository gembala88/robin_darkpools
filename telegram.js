// telegram.js — real-time trade notifications. Non-blocking; failures never break
// trading. For atomic txs it parses the receipt's V4 Swap event so BUY and SELL
// are reported as SEPARATE live messages even though they share one transaction.

import { Interface, formatEther, AbiCoder, id as topicId } from 'ethers';
import { V4 } from './config.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID ? Number(String(process.env.TELEGRAM_CHAT_ID).trim()) : null;
const EXPLORER = 'https://robinhoodchain.blockscout.com/tx/';
const SWAP_TOPIC = topicId('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const coder = AbiCoder.defaultAbiCoder();
const enabled = !!(TOKEN && CHAT);

export async function tg(text) {
  if (!enabled) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML',
        disable_web_page_preview: true, link_preview_options: { is_disabled: true } }),
    });
  } catch { /* swallow — never break the bot on a notif error */ }
}

// --- ETH/USD price (cached 2 min; manual override via ETH_USD_PRICE) ---
let ethUsd = process.env.ETH_USD_PRICE ? Number(process.env.ETH_USD_PRICE) : null;
let priceAt = 0;
async function refreshEthUsd() {
  if (ethUsd && Date.now() - priceAt < 120000) return ethUsd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    if (j?.ethereum?.usd) { ethUsd = j.ethereum.usd; priceAt = Date.now(); }
  } catch { /* keep last known price */ }
  return ethUsd;
}

// ETH amount with USD in parentheses, e.g. "0.000501 ETH ($1.75)"
const eth = (x, d = 6) => {
  const v = Number(formatEther(x));
  return ethUsd ? `${v.toFixed(d)} ETH ($${(v * ethUsd).toFixed(2)})` : `${v.toFixed(d)} ETH`;
};
const fmt = (x, d = 6) => Number(formatEther(x)).toFixed(d);       // plain (token amounts)
const e6 = (x) => Number(formatEther(x)).toFixed(6);               // "0.000200"
const tokN = (x) => Number(formatEther(x)).toLocaleString('en-US', { maximumFractionDigits: 2 }); // "56,112.13"
const usdOf = (x) => (ethUsd ? `$${(Number(formatEther(x)) * ethUsd).toFixed(2)}` : null);
const link = (h) => `<a href="${EXPLORER}${h}">TX</a>`;            // clickable "TX"
const txLink = (h, label = 'TX') => `<a href="${EXPLORER}${h}">${label}</a>`;
const card = (lines) => lines.join('\n');                          // no divider

// Decode the V4 Swap event for our pool from a receipt: returns {ethAbs, tokenAbs}.
export function parseSwap(receipt) {
  for (const lg of receipt.logs || []) {
    if (lg.address.toLowerCase() !== V4.poolManager.toLowerCase()) continue;
    if (!lg.topics.length || lg.topics[0].toLowerCase() !== SWAP_TOPIC.toLowerCase()) continue;
    const [a0, a1] = coder.decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], lg.data);
    const abs = (v) => (v < 0n ? -v : v);
    return { ethAbs: abs(a0), tokenAbs: abs(a1) }; // currency0=ETH, currency1=token
  }
  return null;
}

export async function notifyStartup(mode, markets) {
  await refreshEthUsd();
  return tg([
    `🤖 <b>RoobinArb online</b> — ${mode}`,
    ethUsd ? `ETH: $${ethUsd}` : '',
    `markets: ${markets.map(m => m.symbol).join(', ')}`,
  ].filter(Boolean).join('\n'));
}

const usdParen = (x) => { const u = usdOf(x); return u ? ` (${u})` : ''; };

// EOA-mode: separate calls per leg (card style)
export async function notifyBuy({ symbol, venue, ethIn, tokens, hash }) {
  await refreshEthUsd();
  return tg(card([
    `🟢 <b>${symbol} Buy</b>`,
    ``,
    `🟢 <b>BUY</b> @ ${venue}`,
    `<code>${e6(ethIn)} ETH</code>${usdParen(ethIn)} → <code>${tokN(tokens)} ${symbol}</code>`,
    ``,
    `🔗 ${txLink(hash)}`,
  ]));
}
export async function notifySell({ symbol, venue, tokens, ethOut, hash }) {
  await refreshEthUsd();
  return tg(card([
    `🔴 <b>${symbol} Sell</b>`,
    ``,
    `🔴 <b>SELL</b> @ ${venue}`,
    `<code>${tokN(tokens)} ${symbol}</code> → <code>${e6(ethOut)} ETH</code>${usdParen(ethOut)}`,
    ``,
    `🔗 ${txLink(hash)}`,
  ]));
}

// Atomic-mode: ONE card with BUY, SELL and net P/L.
export async function notifyAtomic({ symbol, dir, buyVenue, sellVenue, sizeEth, receipt, netEth }) {
  await refreshEthUsd();
  const sw = parseSwap(receipt);
  const tokStr = sw ? tokN(sw.tokenAbs) : '?';
  const outWei = dir === 'A' && sw ? sw.ethAbs : 0n;
  const abs = netEth < 0n ? -netEth : netEth;
  const netSign = netEth >= 0n ? '+' : '−';
  const netUsd = ethUsd ? ` (${netSign}$${(Number(formatEther(abs)) * ethUsd).toFixed(2)})` : '';
  const sellValLine = dir === 'A'
    ? `<code>${tokStr} ${symbol}</code> → <code>${e6(outWei)} ETH</code>${usdParen(outWei)}`
    : `<code>${tokStr} ${symbol}</code> → curve`;
  await tg(card([
    `🟢 <b>${symbol} Trade</b>`,
    ``,
    `🟢 <b>BUY</b> @ ${buyVenue}`,
    `<code>${e6(sizeEth)} ETH</code>${usdParen(sizeEth)} → <code>${tokStr} ${symbol}</code>`,
    ``,
    `🔴 <b>SELL</b> @ ${sellVenue}`,
    sellValLine,
    ``,
    `📊 <b>NET</b>`,
    `<code>${netSign}${e6(abs)} ETH</code>${netUsd} • ${dir === 'A' ? 'curve → V4' : 'V4 → curve'}`,
    ``,
    `🔗 ${txLink(receipt.hash, 'Atomic TX')}`,
  ]));
}

export function notifyError(msg) { return tg(`⚠️ <b>arb error</b>\n<code>${String(msg).slice(0, 300)}</code>`); }
export const tgEnabled = enabled;
