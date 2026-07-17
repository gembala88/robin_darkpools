// provider.js — ethers v6 JsonRpcProvider with automatic RPC fallback.
// Primary: RPC_URL env (Alchemy/dRPC) or IP-pinned Cloudflare bypass.
// Fallback: public RPC (rpc.mainnet.chain.robinhood.com) if primary fails.
// Fallback cooldown: 5 minutes before retrying primary.

import https from 'node:https';
import { JsonRpcProvider, Network } from 'ethers';
import { CHAIN } from './config.js';

// Resolve the RPC hostname via Cloudflare DNS-over-HTTPS, bypassing the ISP.
async function resolveViaDoH(host) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: '1.1.1.1', servername: 'cloudflare-dns.com', port: 443, path:
          `/dns-query?name=${host}&type=A`, headers: { accept: 'application/dns-json' } },
      (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const ips = (j.Answer || []).filter(a => a.type === 1).map(a => a.data);
          resolve(ips);
        } catch { resolve([]); }
      }); });
    req.on('error', () => resolve([]));
    req.setTimeout(6000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

const MAX_INFLIGHT = Number(process.env.RPC_CONCURRENCY || 4);
const MAX_RETRIES = Number(process.env.RPC_RETRIES || 5);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class PinnedProvider extends JsonRpcProvider {
  constructor(host, ip) {
    const net = new Network(CHAIN.name, CHAIN.id);
    super('https://' + host, net, { staticNetwork: net, batchMaxCount: 1 });
    this._host = host;
    this._ip = ip;
    this._inflight = 0;
    this._queue = [];
    this._agent = new https.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT, keepAliveMsecs: 15000 });
  }
  _raw(bodyStr) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host: this._ip, servername: this._host, port: 443, method: 'POST', path: '/', agent: this._agent,
          headers: { 'content-type': 'application/json', host: this._host,
                     'content-length': Buffer.byteLength(bodyStr) } },
        (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('RPC timeout')); });
      req.write(bodyStr); req.end();
    });
  }
  async _acquire() {
    if (this._inflight >= MAX_INFLIGHT) await new Promise(r => this._queue.push(r));
    this._inflight++;
  }
  _release() { this._inflight--; const n = this._queue.shift(); if (n) n(); }
  async _post(bodyStr) {
    await this._acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        try { res = await this._raw(bodyStr); }
        catch (e) { if (attempt >= MAX_RETRIES) throw e; await sleep(200 * 2 ** attempt); continue; }
        const rateLimited = res.status === 429 || res.status === 503 ||
          (res.body.includes('"code":429') || res.body.includes('Too Many Requests'));
        if (rateLimited && attempt < MAX_RETRIES) { await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 200)); continue; }
        // Log non-200 responses (esp. 400) with FULL body for diagnosis
        if (res.status !== 200 && res.status !== 429 && res.status !== 503) {
          console.error(`RPC returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
        }
        try { return JSON.parse(res.body); }
        catch { if (attempt < MAX_RETRIES) { await sleep(300 * 2 ** attempt); continue; }
                throw new Error('bad RPC response: ' + res.body.slice(0, 160)); }
      }
    } finally { this._release(); }
  }
  async _send(payload) {
    const resp = await this._post(JSON.stringify(payload));
    return Array.isArray(resp) ? resp : [resp];
  }
}

// ===== FALLBACK PROVIDER =====
// Wraps two providers: primary + fallback. ALL JSON-RPC calls go through
// send(). If primary throws, we switch to fallback for 5 minutes, then
// try primary again.

class FallbackProvider extends JsonRpcProvider {
  constructor(primary, fallback) {
    super('http://127.0.0.1:1', undefined, { staticNetwork: true });
    this._pri = primary;
    this._sec = fallback;
    this._mode = 'primary';
    this._switchTime = 0;
    this._cooldownMs = 5 * 60 * 1000;
  }

  // Override the low-level _send — ALL provider methods funnel through here
  async _send(request) {
    const now = Date.now();
    // Only ATTEMPT primary again after cooldown — and only log recovered if primary itself succeeds
    if (this._mode === 'fallback' && now - this._switchTime > this._cooldownMs) {
      console.log('RPC fallback: cooldown expired, retrying primary');
      try {
        const result = await this._pri._send(request);
        console.log('RPC fallback: primary recovered');
        this._mode = 'primary';
        return result;
      } catch (err) {
        this._switchTime = now; // still down — restart 5min quiet period
        return this._sec._send(request);
      }
    }
    const provider = this._mode === 'primary' ? this._pri : this._sec;
    try {
      return await provider._send(request);
    } catch (err) {
      if (this._mode === 'fallback') throw err; // fallback also failed
      const msg = err.shortMessage || err.message || String(err);
      console.log(`RPC fallback: primary error (${msg.slice(0, 80)}) — switching to fallback for 5min`);
      this._mode = 'fallback';
      this._switchTime = now;
      return this._sec._send(request);
    }
  }
}

// ===== PROVIDER FACTORY =====

export async function makeProvider(envKey = 'RPC_URL') {
  const net = new Network(CHAIN.name, CHAIN.id);
  const opts = { staticNetwork: net, batchMaxCount: 1 };
  const rpcUrl = process.env[envKey] || process.env.RPC_URL;

  // --- Build primary provider ---
  let primary;
  if (rpcUrl) {
    primary = new JsonRpcProvider(rpcUrl, net, opts);
  } else {
    let ips = await resolveViaDoH(CHAIN.rpcHost);
    if (!ips.length) ips = CHAIN.rpcIps;
    primary = new PinnedProvider(CHAIN.rpcHost, ips[0]);
  }

  // --- Build fallback provider (public RPC) ---
  const fallback = new JsonRpcProvider('https://' + CHAIN.rpcHost, net, opts);

  // --- Wrap in fallback logic ---
  const wrapped = new FallbackProvider(primary, fallback);

  // Sanity check (uses FallbackProvider._send → tries primary)
  const n = await wrapped.getNetwork();
  if (Number(n.chainId) !== CHAIN.id) throw new Error(`wrong chain ${n.chainId}`);

  return wrapped;
}
