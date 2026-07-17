import 'dotenv/config';
import fs from 'node:fs';
import { Contract, Interface, id as topicId, getAddress, formatEther, AbiCoder } from 'ethers';
import { makeProvider } from './provider.js';
import { V4, UC, UCW, UCS } from './config.js';
import { tg, tgScreener, setCommandCtx, startCommandHandler } from './telegram.js';
import { analyzeToken } from './llm.js';
import { checkGMGN } from './gmgn.js';

// ===== ON-CHAIN ADDRESSES =====
const FACTORIES = {
  V5: '0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d',
  V4: '0x42B1f2Fb09502b66Ae21769b3384a7788d020d73',
  V3: '0x9A4a94Bd3aF6acF5567A3B22f264E08B0962B8c8',
  V2: '0xD69A9fDee44a42c8E614128FEda486128cB27222',
  V1: '0xD952A74C85a2221a7DaB185c62cfD7EBa8C94AFC',
};

// ===== EVENT SIGNATURES =====
const BUY_SIG  = process.env.BUY_EVENT_SIG  || 'Buy(address,address,uint256,uint256,uint256,uint256)';
const SELL_SIG = process.env.SELL_EVENT_SIG || 'Sell(address,address,uint256,uint256,uint256,uint256)';
const FEE_SIG  = 'FeeCollected(address,uint256)';
const BUY_TOPIC  = topicId(BUY_SIG);
const SELL_TOPIC = topicId(SELL_SIG);
const FEE_TOPIC  = topicId(FEE_SIG);
const ALL_TOPICS = [[BUY_TOPIC, SELL_TOPIC, FEE_TOPIC]];

// ===== SCREENING CONFIG (ALL from user-config.json — NO code defaults) =====
// Env vars SCREENER_* override user-config.json at runtime without file edits
function _env(key, envKey) {
  if (process.env[envKey]) return Number(process.env[envKey]);
  return UC(key);
}
function _envS(key) {
  return process.env['SCREENER_'+key.toUpperCase()] ? Number(process.env['SCREENER_'+key.toUpperCase()]) : UCS(key);
}

const CFG = {
  get minGraduationPct() { return _env('minGraduationPct', 'SCREENER_MIN_GRADUATION'); },
  get minAgeHours() { return _env('minAgeHours', 'SCREENER_MIN_AGE_HOURS'); },
  get minUniqueBuyers() { return _env('minUniqueBuyers', 'SCREENER_MIN_BUYERS'); },
  get minVolumeEth() { return _env('minVolumeEth', 'SCREENER_MIN_VOLUME_ETH'); },
  get pollMs() { return _env('pollMs', 'SCREENER_POLL_MS'); },
  get refreshCurvesSec() { return _env('refreshCurvesSec', 'SCREENER_REFRESH_SEC'); },
  get avgBlockTimeSec() { return _env('avgBlockTimeSec', 'SCREENER_BLOCK_TIME'); },
  get volumeWindowHours() { return _env('volumeWindowHours', 'SCREENER_VOLUME_WINDOW_HOURS'); },
  get stateSaveInterval() { return _env('stateSaveInterval', 'SCREENER_SAVE_INTERVAL'); },
  get minBuyerDistribution() { return _env('minBuyerDistribution', 'SCREENER_MIN_DISTRIBUTION'); },
  get maxSellBuyRatio() { return _env('maxSellBuyRatio', 'SCREENER_MAX_SELL_BUY_RATIO'); },
  get volumeDropThreshold() { return _env('volumeDropThreshold', 'SCREENER_VOL_DROP_THRESHOLD'); },
  get llmScoreMin() { return _env('llmScoreMin', 'SCREENER_LLM_SCORE_MIN'); },
  get llmCooldownHours() { return _env('llmCooldownHours', 'SCREENER_LLM_COOLDOWN_HOURS'); },
  get periodicHours() { return _env('periodicHours', 'SCREENER_PERIODIC_HOURS'); },
  get scanChunkSize() { return _env('scanChunkSize', 'SCREENER_SCAN_CHUNK'); },
  get scanDelayMs() { return _env('scanDelayMs', 'SCREENER_SCAN_DELAY'); },
  get maxRetryDelay() { return _env('maxRetryDelay', 'SCREENER_MAX_RETRY'); },
  // Safety settings from user-config.json → "safety" section
  get safety() { return {
    get maxTaxBps() { return _envS('maxTaxBps'); },
    get minLiquidityEth() { return _envS('minLiquidityEth'); },
    get maxSellBuyRatio() { return _envS('maxSellBuyRatio'); },
    get minBuyerDistribution() { return _envS('minBuyerDistribution'); },
    get honeypotTestEnabled() { return !!UCS('honeypotTestEnabled'); },
    get minUniqueBuyersSafety() { return _envS('minUniqueBuyersSafety'); },
  }; },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const STATE_FILE = 'screener_state.json';

// ===== SHARED INTERFACES =====
const coder = AbiCoder.defaultAbiCoder();
const CURVE_I = new Interface([
  'function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)',
]);
const ERC20_I = new Interface(['function symbol() view returns (string)']);

// ===== STATE =====
let state = { lastScannedBlock: 0, tokens: {} };
let knownPoolTokens = new Set();
let lastStateSave = 0;
let currentHead = 0;
let startTime = Date.now();

// ===== HELPERS =====

function decodeBuyEvent(log) {
  const token = getAddress('0x' + log.topics[1].slice(26));
  const buyer = getAddress('0x' + log.topics[2].slice(26));
  const [ethIn] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
  return { token, buyer, ethIn };
}

function decodeSellEvent(log) {
  const token = getAddress('0x' + log.topics[1].slice(26));
  const seller = getAddress('0x' + log.topics[2].slice(26));
  const [, ethOut] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
  return { token, seller, ethOut };
}

function decodeFeeEvent(log) {
  const token = getAddress('0x' + log.topics[1].slice(26));
  const [amount] = coder.decode(['uint256'], log.data);
  return { token, amount };
}

async function getLogsChunked(provider, filter, from, to, step) {
  if (!step) step = 50_000;
  const out = [];
  for (let s = from; s <= to; s += step) {
    const e = Math.min(s + step - 1, to);
    let cachedStep = step;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        out.push(...await provider.getLogs({ ...filter, fromBlock: s, toBlock: e }));
        break;
      } catch (err) {
        const msg = (err.shortMessage || err.message || '').toLowerCase();
        const code = err.code;
        // Rate limit → exponential backoff
        if (code === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('rate')) {
          if (attempt >= 6) throw err;
          const delay = Math.min(1000 * Math.pow(2, attempt), CFG.maxRetryDelay);
          console.log(`  429 on blocks ${s}–${e} — backoff ${delay}ms (#${attempt + 1})`);
          await sleep(delay + Math.random() * 500);
          continue;
        }
        // Block-range too large (e.g. Alchemy free tier max 10 blocks, HTTP 400)
        if (code === -32600 || msg.includes('block range') || msg.includes('400') || msg.includes('bad response') || msg.includes('10 block') || msg.includes('free tier')) {
          const newStep = Math.max(Math.floor(cachedStep / 2), 10);
          console.log(`  range too large at blocks ${s}–${e} (${e-s+1}) — step ${cachedStep}→${newStep}`);
          if (cachedStep <= 10) throw err;
          cachedStep = newStep;
          // Re-process the current [s,e] range with smaller step
          out.push(...await getLogsChunked(provider, filter, s, e, cachedStep));
          break;
        }
        // Generic error → binary search (last resort)
        if (e > s) {
          const m = (s + e) >> 1;
          out.push(...await getLogsChunked(provider, filter, s, m));
          out.push(...await getLogsChunked(provider, filter, m + 1, e));
        } else throw err;
        break;
      }
    }
  }
  return out;
}

async function getLogsChunkedMulti(provider, addresses, topics, from, to, step = 50_000) {
  const filter = { address: addresses, topics };
  return getLogsChunked(provider, filter, from, to, step);
}

async function loadKnownPoolTokens(provider) {
  const set = new Set();
  try {
    const wl = JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url)));
    for (const w of wl) set.add(w.token.toLowerCase());
    console.log(`watchlist.json: ${set.size} tokens already have V4 pools`);
  } catch {
    console.log('no watchlist.json');
  }
  if (!set.size && process.env.SCREENER_SCAN_V4 === '1') {
    console.log('scanning V4 Initialize events...');
    const initTopic = topicId('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
    const head = await provider.getBlockNumber();
    const raw = await getLogsChunked(provider, { address: V4.poolManager, topics: [initTopic] }, 0, head);
    for (const lg of raw) {
      const c0 = getAddress('0x' + lg.topics[2].slice(26));
      if (BigInt(c0) !== 0n) continue;
      const c1 = getAddress('0x' + lg.topics[3].slice(26));
      set.add(c1.toLowerCase());
    }
    console.log(`V4 scan complete: ${set.size} unique tokens with pools`);
  }
  return set;
}

async function getSymbol(token, provider) {
  try {
    const c = new Contract(token, ['function symbol() view returns (string)'], provider);
    return await c.symbol();
  } catch { return '?'; }
}

async function refreshCurveState(tokenAddr, factoryAddr, provider) {
  try {
    const c = new Contract(factoryAddr, CURVE_I, provider);
    const d = await c.curves(tokenAddr);
    if (d.raiseTarget > 0n) {
      const pct = Number(d.realEth * 10000n / d.raiseTarget) / 100;
      return {
        virtualEth: d.virtualEth, realEth: d.realEth,
        tokenReserve: d.tokenReserve, raiseTarget: d.raiseTarget,
        lpEth: d.lpEth, feeBps: Number(d.tradingFeeBps),
        gradPct: pct, active: d.realEth < d.raiseTarget,
      };
    }
    return null;
  } catch { return null; }
}

function tokenLc(addr) { return addr.toLowerCase(); }

function initTokenInfo(token, factory, buyer, ethIn, blockNumber, symbol) {
  return {
    token: getAddress(token),
    symbol,
    factory,
    firstBuyBlock: blockNumber,
    lastBuyBlock: blockNumber,
    totalEthIn: ethIn.toString(),
    totalEthOut: '0',
    totalFees: '0',
    buyers: [buyer],
    buyEvents: [{ block: blockNumber, buyer, ethIn: ethIn.toString() }],
    sellEvents: [],
    feeEvents: [],
    sellCount: 0,
    feeCount: 0,
    lastGradPct: 0,
    lastActive: true,
    active: true,
    notified: false,
    passedCriteria: false,
    compositeScore: 0,
    milestoneNotified: 0,
    llmDecision: null,
    lastLLMEval: 0,
    llmScoreAtLastEval: 0,
    volume1hEth: 0,
    ageHours: 0,
    buyerConcentration: 0,
    sellBuyRatio: 0,
    gmgnChecked: false,
    gmgnFlaggedRisk: false,
    gmgnFlags: null,
  };
}

function updateTokenInfo(info, buyer, ethIn, blockNumber) {
  info.lastBuyBlock = Math.max(info.lastBuyBlock, blockNumber);
  const prev = BigInt(info.totalEthIn);
  info.totalEthIn = (prev + ethIn).toString();
  if (!info.buyers.includes(buyer)) info.buyers.push(buyer);
  info.buyEvents.push({ block: blockNumber, buyer, ethIn: ethIn.toString() });
  const cutoffBlock = blockNumber - Math.floor((CFG.volumeWindowHours * 2 * 3600) / CFG.avgBlockTimeSec);
  info.buyEvents = info.buyEvents.filter(e => e.block >= cutoffBlock);
  if (info.buyEvents.length > 1000) info.buyEvents = info.buyEvents.slice(-500);
}

function updateSellInfo(info, seller, ethOut, blockNumber) {
  const prev = BigInt(info.totalEthOut);
  info.totalEthOut = (prev + ethOut).toString();
  info.sellCount = (info.sellCount || 0) + 1;
  info.sellEvents.push({ block: blockNumber, seller, ethOut: ethOut.toString() });
  const cutoffBlock = blockNumber - Math.floor((CFG.volumeWindowHours * 2 * 3600) / CFG.avgBlockTimeSec);
  info.sellEvents = info.sellEvents.filter(e => e.block >= cutoffBlock);
  if (info.sellEvents.length > 1000) info.sellEvents = info.sellEvents.slice(-500);
}

function updateFeeInfo(info, amount) {
  const prev = BigInt(info.totalFees || '0');
  info.totalFees = (prev + amount).toString();
  info.feeCount = (info.feeCount || 0) + 1;
}

function computeVolumeInWindow(events, currentBlock, windowHours) {
  const cutoff = currentBlock - Math.floor((windowHours * 3600) / CFG.avgBlockTimeSec);
  let sum = 0n;
  let count = 0;
  for (const e of events) {
    if (e.block >= cutoff) {
      sum += BigInt(e.ethIn || e.ethOut || '0');
      count++;
    }
  }
  return { sum, count };
}

function computeAgeHours(info, currentBlock) {
  const blocks = currentBlock - info.firstBuyBlock;
  return blocks * CFG.avgBlockTimeSec / 3600;
}

// ===== COMPOSITE SCORE =====
function computeScore(info, currentBlock) {
  const vol1h = computeVolumeInWindow(info.buyEvents || [], currentBlock, CFG.volumeWindowHours);
  const volEth = Number(formatEther(vol1h.sum));
  const ageH = computeAgeHours(info, currentBlock);
  const buyerCount = info.buyers.length;
  const grad = info.lastGradPct;

  // Buyer distribution: percentage of total volume from top buyer
  let topBuyerPct = 0;
  const buyerVol = {};
  for (const e of info.buyEvents || []) {
    const b = e.buyer;
    buyerVol[b] = (buyerVol[b] || 0n) + BigInt(e.ethIn);
  }
  const totalBuyVol = Object.values(buyerVol).reduce((a, b) => a + b, 0n);
  if (totalBuyVol > 0n) {
    const maxVol = Object.values(buyerVol).reduce((a, b) => a > b ? a : b, 0n);
    topBuyerPct = Number(maxVol * 10000n / totalBuyVol) / 100;
  }

  // Sell/buy ratio (volume-weighted)
  let sellBuyRatio = 0;
  const sellVol1h = computeVolumeInWindow(info.sellEvents || [], currentBlock, CFG.volumeWindowHours);
  const sellEth = Number(formatEther(sellVol1h.sum));
  if (volEth > 0) sellBuyRatio = sellEth / volEth;

  // Composite score (0-100) — weights from user-config.json (NO defaults)
  const W = (k) => UCW(k);
  let score = 0;
  score += Math.min(grad, 100) * W('graduation');
  score += Math.min(buyerCount, W('buyerCap')) * W('buyers');
  if (volEth > 0) score += Math.min(Math.log10(volEth * 1000 + 1) * W('volumeScale'), W('volumeCap'));
  const distScore = Math.max(0, 100 - topBuyerPct) * W('distribution');
  score += distScore;
  const sellScore = Math.max(0, (1 - sellBuyRatio)) * (W('sellRatio') * 100);
  score += sellScore;

  return {
    compositeScore: Math.round(score),
    grad,
    volume1hEth: volEth,
    ageHours: ageH,
    buyerCount,
    totalBuyVol,
    topBuyerPct,
    sellBuyRatio,
    sellVolEth: sellEth,
  };
}

// ===== SCREENING + SAFETY CRITERIA (ALL from user-config.json) =====
function checkCriteria(info, metrics) {
  const S = CFG.safety;
  const realEth = Number(formatEther(BigInt(info.curveRealEth || '0')));
  const feeBps = Number(info.curveFeeBps || info.tradingFeeBps || 0);
  const passes = {
    graduation: metrics.grad >= CFG.minGraduationPct,
    age: metrics.ageHours >= CFG.minAgeHours,
    buyers: metrics.buyerCount >= CFG.minUniqueBuyers,
    volume: metrics.volume1hEth >= CFG.minVolumeEth,
    distribution: metrics.topBuyerPct <= (100 - CFG.minBuyerDistribution),
    sellBuyRatio: metrics.sellBuyRatio <= CFG.maxSellBuyRatio,
    // Safety checks
    safebuyers: metrics.buyerCount >= S.minUniqueBuyersSafety,
    safetax: feeBps <= S.maxTaxBps,
    safeliquidity: realEth >= S.minLiquidityEth,
    safesellratio: metrics.sellBuyRatio <= S.maxSellBuyRatio,
    safedistribution: metrics.topBuyerPct <= (100 - S.minBuyerDistribution),
    gmgn: !info.gmgnChecked || !info.gmgnFlaggedRisk,
  };
  const allOk = Object.values(passes).every(Boolean);
  return { passes, allOk };
}

// ===== MILESTONE NOTIFICATIONS =====
const MILESTONES = [25, 50, 75, 100];

async function checkMilestone(info, metrics) {
  const grad = info.lastGradPct;
  const currentMs = info.milestoneNotified || 0;
  for (const ms of MILESTONES) {
    if (grad >= ms && currentMs < ms) {
      info.milestoneNotified = ms;
      const ethReal = formatEther(BigInt(info.curveRealEth || '0'));
      const ethTarget = formatEther(BigInt(info.curveRaiseTarget || '0'));
      const emoji = ms === 100 ? '🎓' : ms >= 75 ? '🚀' : ms >= 50 ? '🔥' : '📈';
      await tgScreener([
        `${emoji} <b>${info.symbol}</b> (<code>${info.token.slice(0,10)}&hellip;</code>) reached <b>${ms}%</b> graduation!`,
        `<code>${info.token}</code>`,
        ``,
        `realEth: ${ethReal} ETH / ${ethTarget} ETH target`,
        `buyers: ${metrics.buyerCount} | score: ${metrics.compositeScore}/100`,
        ms === 100 ? `<b>GRADUATED — ready for V4 pool!</b>` : `continue monitoring...`,
      ].join('\n'));
      break;
    }
  }
}

// ===== LLM EVALUATION (with cooldown) =====
async function evaluateWithLLM(info, metrics) {
  if (!process.env.CLAUDE_API_KEY) {
    if (!info._llmWarned) { info._llmWarned = true; console.log('LLM skipped — no CLAUDE_API_KEY in .env'); }
    return;
  }
  if (metrics.compositeScore < CFG.llmScoreMin) return;

  // Cooldown check: skip if evaluated recently UNLESS score jumped >15
  const now = Date.now();
  const cooldownMs = CFG.llmCooldownHours * 3600 * 1000;
  const sinceLastEval = now - (info.lastLLMEval || 0);
  const scoreDelta = metrics.compositeScore - (info.llmScoreAtLastEval || 0);
  if (sinceLastEval < cooldownMs && scoreDelta <= 15) return;

  // Rate-limit: max 1 LLM call per 10s regardless of token count
  if (Date.now() - _lastLLMCall < 10000) return;
  _lastLLMCall = Date.now();

  const result = await analyzeToken(info, currentHead, currentHead, CFG);
  info.lastLLMEval = Date.now();
  info.llmScoreAtLastEval = metrics.compositeScore;
  if (result) {
    info.llmDecision = result;
    if (result.decision === 'YES') {
      await tgScreener([
        `🤖 <b>LLM says YES!</b> — ${info.symbol} (<code>${info.token.slice(0,10)}&hellip;</code>)`,
        `<code>${info.token}</code>`,
        ``,
        `Confidence: ${result.confidence}`,
        `Reason: ${result.reason}`,
        `Score: ${result.score}/100`,
      ].join('\n'));
    }
  }
}
let _lastLLMCall = 0;

// ===== PERIODIC SUMMARY =====
let lastPeriodicSummary = 0;

async function sendPeriodicSummary() {
  const tokens = Object.values(state.tokens);
  const active = tokens.filter(t => t.lastActive);
  const passed = tokens.filter(t => t.passedCriteria);
  const scored = tokens.filter(t => t.compositeScore > 0).sort((a, b) => b.compositeScore - a.compositeScore);

  const top5 = scored.slice(0, 5);
  const lines = [
    `<b>📊 Periodic Summary</b>`,
    ``,
    `Tracked: ${tokens.length} | Active: ${active.length} | Passing: ${passed.length}`,
    `Chain head: ${currentHead}`,
    ``,
  ];
  if (top5.length) {
    lines.push(`<b>Top 5 by score:</b>`);
    for (let i = 0; i < top5.length; i++) {
      const t = top5[i];
      lines.push(`${i + 1}. ${t.symbol} (<code>${t.token.slice(0,10)}&hellip;</code>) — ${t.compositeScore}/100 (${t.lastGradPct.toFixed(1)}%)`);
    }
  } else {
    lines.push(`No scored tokens yet. Let data accumulate.`);
  }

  await tgScreener(lines.join('\n'));
}

// ===== NOTIFY CANDIDATE =====
async function notifyCandidate(info, metrics) {
  const hhiNote = metrics.topBuyerPct > 50 ? ' ⚠️ HIGH' : '';
  const riskFlag = info.gmgnChecked
    ? (info.gmgnFlaggedRisk ? '⚠️ FLAGGED (security risk detected)' : '✅ clean')
    : 'not checked yet';
  // Check if token already has a V4 pool from scan output
  let poolExists = false;
  try {
    const poolData = JSON.parse(fs.readFileSync('./curve_v4_pools.json', 'utf8'));
    const tokKey = info.token.toLowerCase();
    poolExists = (poolData.tokens || []).some(t => t.token.toLowerCase() === tokKey);
  } catch {}
  const poolLine = poolExists
    ? `✅ V4 pool AKTIF — cek lp_screener untuk skor LP`
    : `<i>Pool V4 belum terdeteksi. Jalankan scan_v4_pools.mjs atau tunggu pollLogs arb.js</i>`;
  const msg = [
    `🏆 <b>Pool candidate</b> — ${info.symbol} (<code>${info.token.slice(0,10)}&hellip;</code>)`,
    `<code>${info.token}</code>`,
    ``,
    `📊 graduation: ${metrics.grad.toFixed(1)}% (≥ ${CFG.minGraduationPct}%)`,
    `⏱ age: ${metrics.ageHours.toFixed(1)}h (≥ ${CFG.minAgeHours}h)`,
    `👥 buyers: ${metrics.buyerCount} (≥ ${CFG.minUniqueBuyers})`,
    `💰 volume 1h: ${metrics.volume1hEth.toFixed(4)} ETH (≥ ${CFG.minVolumeEth} ETH)`,
    `📊 buyer concentration: ${metrics.topBuyerPct.toFixed(1)}%${hhiNote}`,
    `🔄 buy/sell ratio: ${metrics.sellBuyRatio.toFixed(3)}`,
    `🛡 GMGN: ${riskFlag}`,
    `🏅 score: ${metrics.compositeScore}/100`,
    ``,
    poolLine,
  ].join('\n');
  await tgScreener(msg);
  console.log(`>>> CANDIDATE: ${info.symbol} (${info.token}) — grad=${metrics.grad}% age=${metrics.ageHours}h buyers=${metrics.buyerCount} vol=${metrics.volume1hEth} ETH score=${metrics.compositeScore} hhi=${metrics.topBuyerPct}% sellRatio=${metrics.sellBuyRatio.toFixed(3)} gmgn=${info.gmgnFlaggedRisk ? 'FLAGGED' : 'ok'}`);
}

// ===== STATE PERSISTENCE =====
async function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    state = JSON.parse(raw);
    console.log(`loaded state: ${Object.keys(state.tokens).length} tracked tokens, lastBlock=${state.lastScannedBlock}`);
    // Migrate v1 → v2 schema (old format used recentEvents, missing new fields)
    let migrated = 0;
    for (const [key, t] of Object.entries(state.tokens)) {
      if (!t.buyEvents) {
        t.buyEvents = (t.recentEvents || []).map(e => ({ block: e.block, buyer: '0x0000000000000000000000000000000000000000', ethIn: e.ethIn }));
        t.sellEvents = [];
        t.feeEvents = [];
        t.sellCount = 0;
        t.feeCount = 0;
        t.totalEthOut = t.totalEthOut || '0';
        t.totalFees = t.totalFees || '0';
        t.compositeScore = 0;
        t.passedCriteria = t.passedCriteria || false;
        t.volume1hEth = 0;
        t.ageHours = 0;
        t.buyerConcentration = 0;
        t.sellBuyRatio = 0;
        t.milestoneNotified = t.milestoneNotified || 0;
        t.llmDecision = t.llmDecision || null;
        t.lastLLMEval = t.lastLLMEval || 0;
        t.llmScoreAtLastEval = t.llmScoreAtLastEval || 0;
        delete t.recentEvents;
        migrated++;
      }
    }
    if (migrated) console.log(`migrated ${migrated} tokens to v2 schema`);
  } catch {
    state = { lastScannedBlock: 0, tokens: {} };
    console.log('no prior state — starting fresh');
  }
}

function saveState() {
  const tmp = STATE_FILE + '.tmp';
  const replacer = (k, v) => typeof v === 'bigint' ? v.toString() : v;
  fs.writeFileSync(tmp, JSON.stringify(state, replacer, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ===== PROCESS EVENTS =====

async function processEvents(provider, logs, blockNumber) {
  let newCount = 0;
  for (const lg of logs) {
    const topic0 = lg.topics[0].toLowerCase();

    if (topic0 === BUY_TOPIC.toLowerCase()) {
      const { token, buyer, ethIn } = decodeBuyEvent(lg);
      if (!ethIn || ethIn <= 0n) continue;
      if (knownPoolTokens.has(tokenLc(token))) continue;

      const key = tokenLc(token);
      let info = state.tokens[key];
      if (!info) {
        const factory = lg.address;
        const sym = await getSymbol(token, provider);
        info = initTokenInfo(token, factory, buyer, ethIn, blockNumber, sym);
        state.tokens[key] = info;
        newCount++;
      } else {
        updateTokenInfo(info, buyer, ethIn, blockNumber);
      }
    }

    else if (topic0 === SELL_TOPIC.toLowerCase()) {
      const { token, seller, ethOut } = decodeSellEvent(lg);
      if (!ethOut || ethOut <= 0n) continue;
      const key = tokenLc(token);
      const info = state.tokens[key];
      if (info) updateSellInfo(info, seller, ethOut, blockNumber);
    }

    else if (topic0 === FEE_TOPIC.toLowerCase()) {
      const { token, amount } = decodeFeeEvent(lg);
      if (!amount || amount <= 0n) continue;
      const key = tokenLc(token);
      const info = state.tokens[key];
      if (info) updateFeeInfo(info, amount);
    }
  }
  return newCount;
}

// ===== SCAN BLOCK RANGE =====

async function scanRange(provider, fromBlock, toBlock) {
  if (fromBlock > toBlock) return 0;
  const allLogs = await getLogsChunkedMulti(provider,
    Object.values(FACTORIES),
    ALL_TOPICS,
    fromBlock, toBlock);
  if (!allLogs.length) return 0;

  let buyCount = 0, sellCount = 0, feeCount = 0;
  for (const lg of allLogs) {
    const t = lg.topics[0].toLowerCase();
    if (t === BUY_TOPIC.toLowerCase()) buyCount++;
    else if (t === SELL_TOPIC.toLowerCase()) sellCount++;
    else if (t === FEE_TOPIC.toLowerCase()) feeCount++;
  }
  console.log(`  logs: ${buyCount} Buy, ${sellCount} Sell, ${feeCount} Fee in blocks ${fromBlock}–${toBlock}`);

  let newTokens = 0;
  const byBlock = new Map();
  for (const lg of allLogs) {
    const b = lg.blockNumber;
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(lg);
  }
  for (const [block, logs] of byBlock) {
    newTokens += await processEvents(provider, logs, block);
  }
  if (newTokens) console.log(`  new tokens: ${newTokens}`);
  return allLogs.length;
}

// ===== HISTORICAL SCAN (checkpointed, progress-logged, rate-limit safe) =====

async function historicalScan(provider, fromBlock, toBlock) {
  const totalBlocks = toBlock - fromBlock + 1;
  const chunkSize = CFG.scanChunkSize;
  const interDelay = CFG.scanDelayMs;
  let totalEvents = 0, totalNew = 0;
  const startTime = Date.now();

  for (let s = fromBlock; s <= toBlock; s += chunkSize) {
    const e = Math.min(s + chunkSize - 1, toBlock);

    // Scan each factory sequentially to spread RPC load
    const allLogs = [];
    for (const [name, addr] of Object.entries(FACTORIES)) {
      const logs = await getLogsChunked(provider, { address: addr, topics: ALL_TOPICS }, s, e);
      allLogs.push(...logs);
    }
    totalEvents += allLogs.length;

    // Process events within this chunk
    if (allLogs.length) {
      let buyCount = 0, sellCount = 0, feeCount = 0;
      for (const lg of allLogs) {
        const t = lg.topics[0].toLowerCase();
        if (t === BUY_TOPIC.toLowerCase()) buyCount++;
        else if (t === SELL_TOPIC.toLowerCase()) sellCount++;
        else if (t === FEE_TOPIC.toLowerCase()) feeCount++;
      }

      const byBlock = new Map();
      for (const lg of allLogs) {
        const b = lg.blockNumber;
        if (!byBlock.has(b)) byBlock.set(b, []);
        byBlock.get(b).push(lg);
      }
      for (const [block, logs] of byBlock) {
        totalNew += await processEvents(provider, logs, block);
      }

      console.log(`  chunk ${s}–${e}: ${buyCount} Buy, ${sellCount} Sell, ${feeCount} Fee ${totalNew ? `| new tokens: ${totalNew}` : ''}`);
    }

    // Checkpoint: save progress after EVERY chunk
    state.lastScannedBlock = e;
    saveState();

    // Progress log with percentage
    const scanned = e - fromBlock + 1;
    const pct = (scanned / totalBlocks * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  scanned ${scanned.toLocaleString()} / ${totalBlocks.toLocaleString()} blocks (${pct}%) — ${totalEvents} events — ${elapsed}s`);

    // Throttle between chunks
    if (e < toBlock) await sleep(interDelay);
  }

  console.log(`historical scan done: ${totalEvents} events, ${totalNew} new tokens in ${((Date.now()-startTime)/1000).toFixed(0)}s`);
  return totalEvents;
}

// ===== EVALUATE ALL TRACKED TOKENS =====

async function evaluateAndNotify(provider, blockNumber, isInitial = false) {
  let passed = 0, total = 0;
  for (const [key, info] of Object.entries(state.tokens)) {
    if (!info.lastActive) continue;
    total++;

    const metrics = computeScore(info, blockNumber);
    info.compositeScore = metrics.compositeScore;
    info.volume1hEth = metrics.volume1hEth;
    info.ageHours = metrics.ageHours;
    info.buyerConcentration = metrics.topBuyerPct;
    info.sellBuyRatio = metrics.sellBuyRatio;

    const { passes, allOk } = checkCriteria(info, metrics);
    info.passedCriteria = allOk;

    if (allOk && !info.notified) {
      info.notified = true;
      await notifyCandidate(info, metrics);
      passed++;
    }

    // Milestone check
    await checkMilestone(info, metrics);

    // LLM eval for high-scoring tokens
    if (metrics.compositeScore >= CFG.llmScoreMin) {
      await evaluateWithLLM(info, metrics);
    }

    // GMGN check (once per token, cached 5 min)
    if (!info.gmgnChecked && metrics.compositeScore >= 10) {
      const g = await checkGMGN(info.token);
      if (g) {
        info.gmgnChecked = true;
        info.gmgnFlaggedRisk = g.isRisky;
        info.gmgnFlags = g.flags;
      }
    }

    // Dashboard line
    if (isInitial || info.lastBuyBlock > blockNumber - 100 || info.passedCriteria) {
      const flag = allOk ? '✅' : info.notified ? '🔔' : '  ';
      const gmgnTag = info.gmgnChecked ? (info.gmgnFlaggedRisk ? '⚠GMGN' : '✓GMGN') : '  GMGN?';
      console.log(`${flag} ${info.symbol.padEnd(10)} ${info.token.slice(0,8)}&hellip; grad=${info.lastGradPct.toFixed(1).padEnd(6)} buyers=${String(metrics.buyerCount).padEnd(3)} vol1h=${metrics.volume1hEth.toFixed(4).padEnd(10)} score=${String(metrics.compositeScore).padEnd(4)} ${allOk ? '✅ALL' : 'FAIL=' + Object.entries(passes).filter(([,v]) => !v).map(([k]) => k).join(',')} ${gmgnTag}`);
    }
  }
  if (isInitial) {
    console.log(`\ninitial evaluation: ${passed}/${total} active tokens passed all criteria`);
  }
}

// ===== REFRESH CURVE STATES =====

async function refreshAllCurves(provider) {
  let updated = 0;
  for (const info of Object.values(state.tokens)) {
    const cs = await refreshCurveState(info.token, info.factory, provider);
    if (cs) {
      info.lastGradPct = cs.gradPct;
      info.lastActive = cs.active;
      info.curveVirtualEth = cs.virtualEth.toString();
      info.curveRealEth = cs.realEth.toString();
      info.curveTokenReserve = cs.tokenReserve.toString();
      info.curveRaiseTarget = cs.raiseTarget.toString();
      info.curveLpEth = cs.lpEth.toString();
      info.curveFeeBps = cs.feeBps;
      updated++;
    } else {
      info.lastActive = false;
    }
  }
  if (updated) console.log(`refreshed curves: ${updated} tokens`);
}

// ===== MAIN =====

async function main() {
  console.log('RobinArb Screener v2 — expanded screening + LLM decision layer\n');
  const provider = await makeProvider('SCREENER_RPC_URL');
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`chainId: ${chainId}`);

  await loadState();
  knownPoolTokens = await loadKnownPoolTokens(provider);

  currentHead = await provider.getBlockNumber();
  console.log(`head: ${currentHead} | factories: ${Object.keys(FACTORIES).length}`);

  // Wire up Telegram command context
  setCommandCtx({
    getTokens: () => state.tokens,
    getHead: () => currentHead,
    getUptime: () => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${h}h ${m}m`;
    },
    getCfg: () => CFG,
  });

  // Start command handler in background
  startCommandHandler().catch(e => console.error('cmdHandler error:', e.message));

  // Initial scan (checkpointed, progress-logged, rate-limit safe)
  const startBlock = state.lastScannedBlock > 0 ? state.lastScannedBlock + 1 : 0;
  if (startBlock <= currentHead) {
    console.log(`\nhistorical scan: ${startBlock} → ${currentHead} (${(currentHead - startBlock + 1).toLocaleString()} blocks)`);
    console.log(`  chunk size: ${CFG.scanChunkSize.toLocaleString()} blocks, delay: ${CFG.scanDelayMs}ms, sequential per factory`);
    const ev = await historicalScan(provider, startBlock, currentHead);
    if (ev === 0) console.log('  (no events found — verify event sigs in .env)');
  } else {
    console.log('state already up-to-date (lastScannedBlock =', state.lastScannedBlock, ')');
  }

  // Refresh all curve states so initial evaluation shows real grad/volume data
  console.log('\nrefreshing curve states...');
  await refreshAllCurves(provider);

  // Immediate evaluation
  console.log('\ninitial evaluation:');
  await evaluateAndNotify(provider, currentHead, true);

  // Enter main loop
  console.log(`\nmonitoring every ${CFG.pollMs}ms (curves every ${CFG.refreshCurvesSec}s, periodic every ${CFG.periodicHours}h)...`);
  await tgScreener(`🔍 <b>Screener v2 online</b> — monitoring ${Object.keys(state.tokens).length} tokens`);

  let lastCurveRefresh = Date.now();
  lastPeriodicSummary = Date.now();

  setInterval(async () => {
    try {
      currentHead = await provider.getBlockNumber();
      if (currentHead > state.lastScannedBlock) {
        const fromBlock = state.lastScannedBlock + 1;
        state.lastScannedBlock = currentHead;
        const evCount = await scanRange(provider, fromBlock, currentHead);
        if (evCount > 0) {
          await evaluateAndNotify(provider, currentHead, false);
        }
      }

      if (Date.now() - lastCurveRefresh > CFG.refreshCurvesSec * 1000) {
        await refreshAllCurves(provider);
        await evaluateAndNotify(provider, await provider.getBlockNumber(), false);
        lastCurveRefresh = Date.now();
      }

      if (Date.now() - lastPeriodicSummary > CFG.periodicHours * 3600 * 1000) {
        await sendPeriodicSummary();
        lastPeriodicSummary = Date.now();
      }

      if (Date.now() - lastStateSave > CFG.stateSaveInterval) {
        saveState();
        lastStateSave = Date.now();
      }
    } catch (err) {
      console.error('loop error:', err.shortMessage || err.message);
    }
  }, CFG.pollMs);

  process.on('SIGINT', () => { console.log('\nshutting down...'); saveState(); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\nshutting down...'); saveState(); process.exit(0); });
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
