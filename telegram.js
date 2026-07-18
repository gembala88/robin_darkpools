import { Interface, formatEther, AbiCoder, id as topicId } from 'ethers';
import { V4 } from './config.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID ? Number(String(process.env.TELEGRAM_CHAT_ID).trim()) : null;
const S_TOKEN = process.env.SCREENER_BOT_TOKEN;
const S_CHAT = process.env.SCREENER_CHAT_ID ? Number(String(process.env.SCREENER_CHAT_ID).trim()) : null;
const S_CHANNEL = process.env.SCREENER_CHANNEL_ID ? Number(String(process.env.SCREENER_CHANNEL_ID).trim()) : null;
const EXPLORER = 'https://robinhoodchain.blockscout.com/tx/';
const SWAP_TOPIC = topicId('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const coder = AbiCoder.defaultAbiCoder();
const enabled = !!(TOKEN && CHAT);
const screenerEnabled = !!(S_TOKEN && S_CHAT);

export async function tg(text) {
  if (!enabled) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML',
        disable_web_page_preview: true, link_preview_options: { is_disabled: true } }),
    });
    if (S_CHANNEL) await _screenerSend(S_CHANNEL, text);
  } catch {}
}

async function _screenerSend(chatId, text) {
  if (!S_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${S_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, link_preview_options: { is_disabled: true } }),
    });
  } catch {}
}

export async function tgScreener(text) {
  if (!screenerEnabled && !S_CHANNEL) return;
  if (screenerEnabled) await _screenerSend(S_CHAT, text);
  if (S_CHANNEL && S_CHANNEL !== S_CHAT) await _screenerSend(S_CHANNEL, text);
}

// --- ETH/USD price ---
let ethUsd = process.env.ETH_USD_PRICE ? Number(process.env.ETH_USD_PRICE) : null;
let priceAt = 0;
async function refreshEthUsd() {
  if (ethUsd && Date.now() - priceAt < 120000) return ethUsd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    if (j?.ethereum?.usd) { ethUsd = j.ethereum.usd; priceAt = Date.now(); }
  } catch {}
  return ethUsd;
}

const eth = (x, d = 6) => {
  const v = Number(formatEther(x));
  return ethUsd ? `${v.toFixed(d)} ETH ($${(v * ethUsd).toFixed(2)})` : `${v.toFixed(d)} ETH`;
};
const fmt = (x, d = 6) => Number(formatEther(x)).toFixed(d);
const e6 = (x) => Number(formatEther(x)).toFixed(6);
const tokN = (x) => Number(formatEther(x)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const usdOf = (x) => (ethUsd ? `$${(Number(formatEther(x)) * ethUsd).toFixed(2)}` : null);
const link = (h) => `<a href="${EXPLORER}${h}">TX</a>`;
const txLink = (h, label = 'TX') => `<a href="${EXPLORER}${h}">${label}</a>`;
const card = (lines) => lines.join('\n');

export function parseSwap(receipt) {
  for (const lg of receipt.logs || []) {
    if (lg.address.toLowerCase() !== V4.poolManager.toLowerCase()) continue;
    if (!lg.topics.length || lg.topics[0].toLowerCase() !== SWAP_TOPIC.toLowerCase()) continue;
    const [a0, a1] = coder.decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], lg.data);
    const abs = (v) => (v < 0n ? -v : v);
    return { ethAbs: abs(a0), tokenAbs: abs(a1) };
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

export async function notifyBuy({ symbol, token, venue, ethIn, tokens, hash }) {
  await refreshEthUsd();
  const tag = token ? ` (${token.slice(0,8)}&hellip;)` : '';
  return tg(card([
    `🟢 <b>${symbol}${tag} Buy</b>`,
    ``,
    `🟢 <b>BUY</b> @ ${venue}`,
    `<code>${e6(ethIn)} ETH</code>${usdParen(ethIn)} → <code>${tokN(tokens)} ${symbol}</code>`,
    ``,
    `🔗 ${txLink(hash)}`,
  ]));
}
export async function notifySell({ symbol, token, venue, tokens, ethOut, hash }) {
  await refreshEthUsd();
  const tag = token ? ` (${token.slice(0,8)}&hellip;)` : '';
  return tg(card([
    `🔴 <b>${symbol}${tag} Sell</b>`,
    ``,
    `🔴 <b>SELL</b> @ ${venue}`,
    `<code>${tokN(tokens)} ${symbol}</code> → <code>${e6(ethOut)} ETH</code>${usdParen(ethOut)}`,
    ``,
    `🔗 ${txLink(hash)}`,
  ]));
}

export async function notifyAtomic({ symbol, token, dir, buyVenue, sellVenue, sizeEth, receipt, netEth }) {
  await refreshEthUsd();
  const sw = parseSwap(receipt);
  const tokStr = sw ? tokN(sw.tokenAbs) : '?';
  const outWei = dir === 'A' && sw ? sw.ethAbs : 0n;
  const computedNet = (dir === 'A' && sw) ? (outWei - sizeEth) : netEth;
  const abs = computedNet < 0n ? -computedNet : computedNet;
  const netSign = computedNet >= 0n ? '+' : '\u2212';
  const netUsd = ethUsd ? ` (${netSign}$${(Number(formatEther(abs)) * ethUsd).toFixed(2)})` : '';
  const tag = token ? ` (${token.slice(0,8)}&hellip;)` : '';
  const sellValLine = dir === 'A'
    ? `<code>${tokStr} ${symbol}</code> \u2192 <code>${e6(outWei)} ETH</code>${usdParen(outWei)}`
    : `<code>${tokStr} ${symbol}</code> \u2192 curve`;
  await tg(card([
    `🟢 <b>${symbol}${tag} Trade</b>`,
    ``,
    `🟢 <b>BUY</b> @ ${buyVenue}`,
    `<code>${e6(sizeEth)} ETH</code>${usdParen(sizeEth)} \u2192 <code>${tokStr} ${symbol}</code>`,
    ``,
    `🔴 <b>SELL</b> @ ${sellVenue}`,
    sellValLine,
    ``,
    `📊 <b>NET</b>`,
    `<code>${netSign}${e6(abs)} ETH</code>${netUsd} \u2022 ${dir === 'A' ? 'curve \u2192 V4' : 'V4 \u2192 curve'}`,
    ``,
    `🔗 ${txLink(receipt.hash, 'Atomic TX')}`,
  ]));
}

export async function notifyTrade({ symbol, token, sizeEth, netEth, netBps, sellHash, dir }) {
  await refreshEthUsd();
  const abs = netEth < 0n ? -netEth : netEth;
  const netSign = netEth >= 0n ? '+' : '\u2212';
  const netUsd = ethUsd ? ` (${netSign}$${(Number(formatEther(abs)) * ethUsd).toFixed(2)})` : '';
  return tg(card([
    `✅ <b>${symbol}${token ? ` (${token.slice(0,8)}&hellip;)` : ''} arb sukses</b>`,
    ``,
    `Size: <code>${fmt(sizeEth)} ETH</code>${usdParen(sizeEth)}`,
    `Profit: <b>${netSign}${fmt(abs)} ETH</b>${netUsd} (${Number(netBps) / 100} bps)`,
    `Direction: ${dir === 'A' ? 'curve \u2192 V4' : 'V4 \u2192 curve'}`,
    ``,
    `🔗 ${txLink(sellHash, 'TX Exec')}`,
  ]));
}

export async function notifyExecFail({ symbol, token, sizeEth, reason }) {
  await refreshEthUsd();
  return tg(card([
    `❌ <b>${symbol}${token ? ` (${token.slice(0,8)}&hellip;)` : ''} exec GAGAL</b>`,
    ``,
    `Size: <code>${fmt(sizeEth)} ETH</code>${usdParen(sizeEth)}`,
    `Error: <code>${String(reason).slice(0, 200)}</code>`,
  ]));
}

export function notifyError(msg) { return tg(`⚠️ <b>arb error</b>\n<code>${String(msg).slice(0, 300)}</code>`); }
export const tgEnabled = enabled;
