import https from 'node:https';
import { Interface, AbiCoder, keccak256, getAddress } from 'ethers';

const HOST = 'rpc.mainnet.chain.robinhood.com';
const IP = '104.20.46.209';
const TOKEN = '0x45c2a2462e4ffc37e9698b46361f0f6444544663';
const POOLID = '0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362';
const STATEVIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const FACTORIES = {
  V5: '0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d',
  V4: '0x42B1f2Fb09502b66Ae21769b3384a7788d020d73',
  V3: '0x9A4a94Bd3aF6acF5567A3B22f264E08B0962B8c8',
  V2: '0xD69A9fDee44a42c8E614128FEda486128cB27222',
  V1: '0xD952A74C85a2221a7DaB185c62cfD7EBa8C94AFC',
};

let id = 1;
function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: id++, method, params });
  return new Promise((res, rej) => {
    const req = https.request(
      { host: IP, servername: HOST, port: 443, method: 'POST', path: '/',
        headers: { 'content-type': 'application/json', host: HOST, 'content-length': Buffer.byteLength(body) } },
      (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(new Error(d.slice(0,200)))} }); });
    req.on('error', rej); req.write(body); req.end();
  });
}
async function call(to, data) {
  const r = await rpc('eth_call', [{ to, data }, 'latest']);
  if (r.error) return { err: r.error.message };
  return { data: r.result };
}

const curveIface = new Interface([
  'function quoteBuy(address token,uint256 ethIn) view returns (uint256 tokensOut)',
  'function quoteSell(address token,uint256 tokensIn) view returns (uint256 ethOut)',
  'function currentPrice(address token) view returns (uint256)',
  'function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 tradingFeeBps)',
]);
const svIface = new Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const c = await rpc('eth_chainId', []);
console.log('chainId', c.result, '=', parseInt(c.result, 16));

console.log('\n== find managing factory (curves + quoteBuy 0.01 ETH) ==');
let manager = null, curveState = null;
for (const [ver, addr] of Object.entries(FACTORIES)) {
  const q = await call(addr, curveIface.encodeFunctionData('quoteBuy', [TOKEN, 10n ** 16n]));
  const cs = await call(addr, curveIface.encodeFunctionData('curves', [TOKEN]));
  let out = '(revert)';
  if (q.data && q.data !== '0x') {
    try { out = curveIface.decodeFunctionResult('quoteBuy', q.data)[0].toString(); } catch {}
  }
  let raiseTarget = null, realEth = null, tokenReserve = null;
  if (cs.data && cs.data !== '0x') {
    try { const d = curveIface.decodeFunctionResult('curves', cs.data);
      realEth = d.realEth; raiseTarget = d.raiseTarget; tokenReserve = d.tokenReserve; } catch {}
  }
  console.log(`${ver} ${addr}  quoteBuy=${out}  raiseTarget=${raiseTarget} realEth=${realEth} tokenReserve=${tokenReserve}`);
  if (!manager && raiseTarget != null && raiseTarget > 0n) { manager = { ver, addr }; curveState = { realEth, raiseTarget, tokenReserve }; }
}

if (manager) {
  console.log('\n>> MANAGER =', manager.ver, manager.addr);
  const cp = await call(manager.addr, curveIface.encodeFunctionData('currentPrice', [TOKEN]));
  if (cp.data && cp.data !== '0x') console.log('currentPrice(wei/token) =', curveIface.decodeFunctionResult('currentPrice', cp.data)[0].toString());
  const pct = curveState.raiseTarget > 0n ? Number(curveState.realEth * 10000n / curveState.raiseTarget) / 100 : 0;
  console.log(`graduation progress: realEth=${curveState.realEth}  raiseTarget=${curveState.raiseTarget}  => ${pct}%  graduated=${curveState.realEth >= curveState.raiseTarget}`);
} else {
  console.log('\n>> No curve manages this token on any factory version. Likely already GRADUATED (curve closed).');
}

console.log('\n== derive V4 PoolKey for poolId ==');
const abi = AbiCoder.defaultAbiCoder();
const NATIVE = '0x0000000000000000000000000000000000000000';
const feeList = [100, 500, 3000, 10000, 0x800000];
const tsList = [1, 10, 30, 50, 60, 100, 200, 2000];
const hookList = [NATIVE];
const target = POOLID.toLowerCase();
let found = null;
const [a0, a1] = BigInt(NATIVE) < BigInt(TOKEN) ? [NATIVE, TOKEN] : [TOKEN, NATIVE];
outer: for (const fee of feeList) for (const ts of tsList) for (const hooks of hookList) {
  const enc = abi.encode(['address','address','uint24','int24','address'], [getAddress(a0), getAddress(a1), fee, ts, hooks]);
  if (keccak256(enc).toLowerCase() === target) { found = { currency0: a0, currency1: a1, fee, tickSpacing: ts, hooks }; break outer; }
}
console.log(found ? ('MATCH PoolKey = ' + JSON.stringify(found)) : 'no PoolKey match in tried combos (fee/tickSpacing may differ)');

console.log('\n== V4 pool state (StateView) ==');
const liq = await call(STATEVIEW, svIface.encodeFunctionData('getLiquidity', [POOLID]));
if (liq.data && liq.data !== '0x') console.log('liquidity =', svIface.decodeFunctionResult('getLiquidity', liq.data)[0].toString());
else console.log('getLiquidity ->', liq.err || 'empty');
const s0 = await call(STATEVIEW, svIface.encodeFunctionData('getSlot0', [POOLID]));
if (s0.data && s0.data !== '0x') { const d = svIface.decodeFunctionResult('getSlot0', s0.data);
  console.log('slot0 sqrtPriceX96 =', d[0].toString(), 'tick =', d[1].toString(), 'lpFee =', d[3].toString()); }
else console.log('getSlot0 ->', s0.err || 'empty');
