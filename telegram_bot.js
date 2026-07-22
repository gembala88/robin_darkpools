import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { formatEther } from 'ethers';
import { makeProvider } from './provider.js';

const TOKEN = process.env.SCREENER_BOT_TOKEN;
const PAUSE_FLAG = path.join(process.cwd(), 'auto_open_paused.flag');
const LP_STATE = new URL('./lp_state.json', import.meta.url);
const SCREENER_STATE = new URL('./screener_state.json', import.meta.url);
const CONFIG_JSON = new URL('./user-config.json', import.meta.url);

const CONFIG_KEYS = {
  maxActivePositions: { path: ['lp', 'maxActivePositions'], label: 'maxActivePositions' },
  positionSizeEth: { path: ['lp', 'positionSizeEth'], label: 'positionSizeEth' },
  takeProfitArmPct: { path: ['lp', 'takeProfitArmPct'], label: 'takeProfitArmPct' },
  ilExitThresholdPct: { path: ['lp', 'ilExitThresholdPct'], label: 'ilExitThresholdPct' },
  swapRatioPct: { path: ['lp', 'swapRatioPct'], label: 'swapRatioPct' },
};

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

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n');
}

function deepSet(obj, path, val) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur[path[i]] || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = val;
}

async function cmdConfig(chatId) {
  const cfg = loadConfig();
  const lines = ['<b>⚙️ LP Config</b>\n'];
  for (const [cmd, meta] of Object.entries(CONFIG_KEYS)) {
    let val = cfg;
    for (const p of meta.path) val = val?.[p];
    lines.push(`  <code>/${cmd}</code> → ${meta.label}: <b>${val ?? 'N/A'}</b>`);
  }
  lines.push('', 'Gunakan perintah di atas untuk mengubah nilai.');
  await sendMsg(chatId, lines.join('\n'));
}

async function cmdSetKey(chatId, cmdName, rawVal, keyMeta, parseFn, validateMsg) {
  const val = parseFn(rawVal);
  if (val === null || val === undefined || isNaN(val)) {
    return sendMsg(chatId, `Format salah. ${validateMsg}`);
  }
  const cfg = loadConfig();
  deepSet(cfg, keyMeta.path, val);
  saveConfig(cfg);
  await sendMsg(chatId,
    `✅ <b>${keyMeta.label}</b> diubah ke <b>${val}</b>\n\n` +
    `⚠️ Restart bot diperlukan agar perubahan diterapkan:\n<code>pm2 restart robin-arb</code>\n\n` +
    `Ketik /config untuk verifikasi.`
  );
}

async function handleCommand(text, chatId) {
  const args = text.split(/\s+/);
  const cmd = args[0].toLowerCase();
  switch (cmd) {
    case '/status': return cmdStatus(chatId);
    case '/positions': return cmdPositions(chatId);
    case '/pause': return cmdPause(chatId);
    case '/resume': return cmdResume(chatId);
    case '/screener': return cmdScreener(chatId);
    case '/config': return cmdConfig(chatId);
    case '/setmax':
      return cmdSetKey(chatId, '/setmax', args[1], CONFIG_KEYS.maxActivePositions,
        v => { const n = parseInt(v); return (!isNaN(n) && n > 0) ? n : null; },
        'Gunakan: /setmax &lt;angka positif&gt;');
    case '/setsize':
      return cmdSetKey(chatId, '/setsize', args[1], CONFIG_KEYS.positionSizeEth,
        v => { const n = parseFloat(v); return (!isNaN(n) && n > 0) ? n : null; },
        'Gunakan: /setsize &lt;ETH&gt; (misal 0.002)');
    case '/settp':
      return cmdSetKey(chatId, '/settp', args[1], CONFIG_KEYS.takeProfitArmPct,
        v => { const n = parseFloat(v); return (!isNaN(n) && n > 0) ? n : null; },
        'Gunakan: /settp &lt;persen&gt; (misal 20)');
    case '/setil':
      return cmdSetKey(chatId, '/setil', args[1], CONFIG_KEYS.ilExitThresholdPct,
        v => { const n = parseFloat(v); return (!isNaN(n) && n > 0) ? n : null; },
        'Gunakan: /setil &lt;persen&gt; (misal 20)');
    case '/setswapratio':
      return cmdSetKey(chatId, '/setswapratio', args[1], CONFIG_KEYS.swapRatioPct,
        v => { const n = parseFloat(v); return (!isNaN(n) && n >= 0 && n <= 100) ? n : null; },
        'Gunakan: /setswapratio &lt;0-100&gt;');
    default:
      await sendMsg(chatId,
        `Unknown command.\n\nAvailable:\n<code>/status</code> — bot overview\n<code>/positions</code> — active LP positions\n<code>/screener</code> — screener overview (tracked, active, passing)\n<code>/pause</code> — pause auto-open\n<code>/resume</code> — resume auto-open\n<code>/config</code> — current LP config\n<code>/setmax</code> — change maxActivePositions\n<code>/setsize</code> — change positionSizeEth\n<code>/settp</code> — change takeProfitArmPct\n<code>/setil</code> — change ilExitThresholdPct\n<code>/setswapratio</code> — change swapRatioPct`);
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
