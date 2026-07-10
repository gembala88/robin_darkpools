// provider.js — ethers v6 JsonRpcProvider that works behind the ISP DNS block.
// It connects straight to the Cloudflare origin IP while keeping SNI + Host =
// the real hostname (so TLS + Cloudflare routing still work). If RPC_URL is set
// (e.g. an Alchemy/dRPC endpoint on a VPS), it uses a plain provider instead.

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
  // concurrency-limited POST with 429/503 backoff
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

export async function makeProvider() {
  if (process.env.RPC_URL) {
    const net = new Network(CHAIN.name, CHAIN.id);
    return new JsonRpcProvider(process.env.RPC_URL, net, { staticNetwork: net });
  }
  let ips = await resolveViaDoH(CHAIN.rpcHost);
  if (!ips.length) ips = CHAIN.rpcIps;
  const provider = new PinnedProvider(CHAIN.rpcHost, ips[0]);
  // sanity check
  const n = await provider.getNetwork();
  if (Number(n.chainId) !== CHAIN.id) throw new Error(`wrong chain ${n.chainId}`);
  return provider;
}
