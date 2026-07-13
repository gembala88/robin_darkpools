import { execSync } from 'node:child_process';

const KEY = process.env.GMGN_API_KEY;
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function n(v) { return Number(v || 0); }

function runCLI(cmd, tokenAddr) {
  return execSync(
    `npx gmgn-cli ${cmd} --chain robinhood --address ${tokenAddr} --raw`,
    { timeout: 10000, env: { ...process.env, GMGN_API_KEY: KEY } }
  ).toString();
}

export async function checkGMGN(tokenAddr) {
  if (!KEY) return null;

  const cached = cache.get(tokenAddr);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const sec = JSON.parse(runCLI('token security', tokenAddr));
    const info = JSON.parse(runCLI('token info', tokenAddr));

    const s = info.stat || {};
    const d = info.dev || {};
    const flags = [];

    if (sec.is_honeypot) flags.push('HONEYPOT');
    if (sec.is_blacklist) flags.push('BLACKLIST');
    if (!sec.is_renounced) flags.push('NOT_RENOUNCED');
    if (!sec.is_open_source) flags.push('UNVERIFIED');
    if (n(sec.buy_tax) > 0 || n(sec.sell_tax) > 0) flags.push('TAX');
    if (n(sec.high_tax) > 0) flags.push('HIGH_TAX');
    if (d.creator_token_status === 'creator_hold') flags.push('DEV_HOLD');
    if (n(s.creator_hold_rate) > 0) flags.push('DEV_HOLD');
    if (n(s.top_10_holder_rate) > 0.5) flags.push('CONCENTRATED');
    if (n(s.top_bundler_trader_percentage) > 0.3) flags.push('BUNDLED');
    if (n(s.top70_sniper_hold_rate) > 0.1) flags.push('SNIPER_HEAVY');

    const result = { flags, isRisky: flags.length > 0, holders: info.holder_count };
    cache.set(tokenAddr, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

export function getGMGNCache() { return cache; }
