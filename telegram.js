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

// ===== SCREENER COMMAND HANDLER =====

let cmdCtx = null;
export function setCommandCtx(ctx) { cmdCtx = ctx; }

let lastUpdateId = 0;
let commandRunning = false;

export async function startCommandHandler() {
  if (!screenerEnabled || commandRunning) return;
  commandRunning = true;
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${S_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=60`);
      const j = await r.json();
      for (const u of j.result || []) {
        if (u.update_id > lastUpdateId) lastUpdateId = u.update_id;
        const msg = u.message;
        if (!msg?.text) continue;
        await handleCommand(msg.text, msg.chat.id);
      }
    } catch {}
  }
}

async function sendMsg(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${S_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, link_preview_options: { is_disabled: true } }),
    });
  } catch {}
}

async function handleCommand(text, chatId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  if (!cmdCtx) {
    await sendMsg(chatId, 'Screener not initialized.');
    return;
  }

  switch (cmd) {
    case '/status': return cmdStatus(chatId);
    case '/top': return cmdTop(chatId, parseInt(arg) || 5);
    case '/token': return cmdToken(chatId, arg);
    case '/help':
      await sendMsg(chatId, [
        `<b>Available commands:</b>`,
        ``,
        `<code>/status</code> — screener overview`,
        `<code>/top [N]</code> — top N tokens by composite score`,
        `<code>/token &lt;symbol|0x&gt;</code> — details for one token`,
      ].join('\n'));
      return;
    default:
      await sendMsg(chatId, `Unknown command. Try /help`);
  }
}

async function cmdStatus(chatId) {
  const { getTokens, getHead, getUptime, getCfg } = cmdCtx;
  const tokens = Object.values(getTokens());
  const head = getHead();
  const uptime = getUptime();
  const cfg = getCfg();
  const active = tokens.filter(t => t.lastActive).length;
  const passed = tokens.filter(t => t.passedCriteria).length;
  const eligible = tokens.filter(t => t.notified).length;

  await sendMsg(chatId, [
    `<b>🔍 Screener Status</b>`,
    ``,
    `Tokens tracked: ${tokens.length}`,
    `Active (curve exists): ${active}`,
    `Passing criteria: ${passed}`,
    `Eligible for pool: ${eligible}`,
    `Chain head: ${head}`,
    `Uptime: ${uptime}`,
    `Volume window: ${cfg.volumeWindowHours}h`,
    `LLM: ${process.env.CLAUDE_API_KEY ? 'connected' : 'not configured'}`,
  ].join('\n'));
}

async function cmdTop(chatId, n = 5) {
  const { getTokens } = cmdCtx;
  const sorted = Object.values(getTokens())
    .filter(t => t.lastActive && t.compositeScore > 0)
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, Math.min(n, 20));

  if (!sorted.length) {
    await sendMsg(chatId, 'No scored tokens yet. Let data accumulate and curves refresh.');
    return;
  }

  const lines = [`<b>🏆 Top ${sorted.length} Tokens</b>\n`];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    lines.push(`${i + 1}. <b>${t.symbol}</b> (<code>${t.token.slice(0,10)}&hellip;</code>) — score ${t.compositeScore}/100`);
    lines.push(`   grad: ${t.lastGradPct.toFixed(1)}% | buyers: ${t.buyers.length} | vol 1h: ${(t.volume1hEth || 0).toFixed(4)} ETH`);
    if (t.llmDecision) {
      lines.push(`   🤖 LLM: ${t.llmDecision.decision} (${t.llmDecision.confidence})`);
    }
    lines.push('');
  }
  await sendMsg(chatId, lines.join('\n'));
}

async function cmdToken(chatId, query) {
  if (!query) { await sendMsg(chatId, 'Usage: /token <symbol> or /token <0x...>'); return; }
  const { getTokens, getHead } = cmdCtx;
  const lq = query.toLowerCase();
  const match = Object.values(getTokens()).find(
    t => t.symbol.toLowerCase() === lq || t.token.toLowerCase() === lq
  );
  if (!match) { await sendMsg(chatId, `Token not found: ${query}`); return; }

  const head = getHead();
  const lines = [
    `<b>${match.symbol}</b>`,
    `<code>${match.token}</code>`,
    ``,
    `Graduation: ${match.lastGradPct.toFixed(2)}%`,
    `Score: ${match.compositeScore || '?'}/100`,
    `Buyers: ${match.buyers.length} | Sells: ${match.sellCount || 0}`,
    `Total ETH in: ${match.totalEthIn ? formatEther(BigInt(match.totalEthIn)) : '0'} ETH`,
    `Total ETH out (sells): ${match.totalEthOut ? formatEther(BigInt(match.totalEthOut)) : '0'} ETH`,
    `Volume 1h: ${(match.volume1hEth || 0).toFixed(4)} ETH`,
    `Age: ${(match.ageHours || 0).toFixed(1)}h`,
    `Last buy: ${head - match.lastBuyBlock} blocks ago`,
    match.passedCriteria ? '✅ <b>Passes all criteria</b>' : '❌ Does not pass all criteria',
    match.llmDecision ? `🤖 LLM: ${match.llmDecision.decision} (${match.llmDecision.confidence}) — ${match.llmDecision.reason}` : '',
  ].filter(Boolean);
  await sendMsg(chatId, lines.join('\n'));
}
