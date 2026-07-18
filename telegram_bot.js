import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { formatEther } from 'ethers';
import { makeProvider } from './provider.js';

const TOKEN = process.env.SCREENER_BOT_TOKEN;
const PAUSE_FLAG = path.join(process.cwd(), 'auto_open_paused.flag');
const LP_STATE = new URL('./lp_state.json', import.meta.url);
const SCREENER_STATE = new URL('./screener_state.json', import.meta.url);

let lastUpdateId = 0;
let commandRunning = false;

function sendMsg(chatId, text) {
  return fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML',
      disable_web_page_preview: true, link_preview_options: { is_disabled: true } }),
  }).catch(() => {});
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(LP_STATE, 'utf8')); } catch { return { positions: [], monitor: {} }; }
}

async function cmdStatus(chatId) {
  const state = loadState();
  const positions = state.positions || [];
  let ethBal = '?';
  try {
    const prov = await makeProvider('LP_SCREENER_RPC_URL');
    const addr = process.env.WALLET_ADDRESS;
    if (addr) ethBal = `${formatEther(await prov.getBalance(addr))} ETH`;
  } catch {}
  const paused = fs.existsSync(PAUSE_FLAG);

  const lines = [
    '<b>🤖 LP Operations Status</b>',
    '',
    `Auto-open: ${paused ? '\u{1F534} PAUSED' : '\u{1F7E2} ACTIVE'}`,
    `Active positions: ${positions.length}`,
    `ETH balance: ${ethBal}`,
    `Pause flag: ${paused ? PAUSE_FLAG : '(none)'}`,
  ];
  await sendMsg(chatId, lines.join('\n'));
}

async function cmdPositions(chatId) {
  const state = loadState();
  const positions = state.positions || [];
  if (!positions.length) {
    await sendMsg(chatId, 'No active LP positions.');
    return;
  }
  const lines = [`<b>📊 LP Positions (${positions.length})</b>\n`];
  for (const p of positions) {
    const tickInfo = p.tickLower !== undefined
      ? `Tick ${p.tickLower} → ${p.tickUpper} (entry: ${p.entryTick ?? '?'})`
      : 'No tick data';
    lines.push(
      `<code>#${p.tokenId}</code> | ${p.pool || p.dex} | ${tickInfo}`
    );
  }
  await sendMsg(chatId, lines.join('\n'));
}

async function cmdPause(chatId) {
  try {
    fs.writeFileSync(PAUSE_FLAG, new Date().toISOString());
    await sendMsg(chatId, '\u{1F534} Auto-open PAUSED.\ncheckAutoOpenConditions() will return pass:false until /resume.');
  } catch (e) {
    await sendMsg(chatId, `\u{274C} Gagal set pause flag: ${e.message}`);
  }
}

async function cmdResume(chatId) {
  try {
    if (fs.existsSync(PAUSE_FLAG)) fs.unlinkSync(PAUSE_FLAG);
    await sendMsg(chatId, '\u{1F7E2} Auto-open RESUMED.');
  } catch (e) {
    await sendMsg(chatId, `\u{274C} Gagal hapus pause flag: ${e.message}`);
  }
}

async function cmdScreener(chatId) {
  let data;
  try { data = JSON.parse(fs.readFileSync(SCREENER_STATE, 'utf8')); } catch { data = null; }
  if (!data || !data.tokens) {
    await sendMsg(chatId, 'Screener state not available yet. Tunggu screener berjalan.');
    return;
  }
  const tokens = Object.values(data.tokens);
  const total = tokens.length;
  const active = tokens.filter(t => t.lastActive).length;
  const passed = tokens.filter(t => t.passedCriteria).length;
  const eligible = tokens.filter(t => t.notified).length;
  const head = data.lastScannedBlock || '?';

  const lines = [
    '<b>\u{1F50D} Screener Overview</b>',
    '',
    `Tokens tracked: ${total}`,
    `Active (curve exists): ${active}`,
    `Passing criteria: ${passed}`,
    `Eligible for pool: ${eligible}`,
    `Chain head: ${head}`,
  ];
  await sendMsg(chatId, lines.join('\n'));
}

async function handleCommand(text, chatId) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  switch (cmd) {
    case '/status': return cmdStatus(chatId);
    case '/positions': return cmdPositions(chatId);
    case '/pause': return cmdPause(chatId);
    case '/resume': return cmdResume(chatId);
    case '/screener': return cmdScreener(chatId);
    default:
      await sendMsg(chatId,
        `Unknown command.\n\nAvailable:\n<code>/status</code> — bot overview\n<code>/positions</code> — active LP positions\n<code>/screener</code> — screener overview (tracked, active, passing)\n<code>/pause</code> — pause auto-open\n<code>/resume</code> — resume auto-open`);
  }
}

async function startPolling() {
  if (!TOKEN) {
    console.error('telegram_bot: SCREENER_BOT_TOKEN not set. Skipping bot.');
    process.exit(1);
  }
  if (commandRunning) return;
  commandRunning = true;
  console.log('telegram_bot: polling for commands...');

  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=60`);
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

startPolling().catch(e => { console.error('telegram_bot FATAL:', e.message); process.exit(1); });
