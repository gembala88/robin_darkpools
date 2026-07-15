import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes } from 'ethers';
const c = AbiCoder.defaultAbiCoder();
const p = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const S = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const s0 = dataSlice(keccak256(toUtf8Bytes('getSlot0(bytes32)')), 0, 4);
const liq = dataSlice(keccak256(toUtf8Bytes('getLiquidity(bytes32)')), 0, 4);
async function check(pid, name) {
  const r0 = await p.call({ to: S, data: s0 + c.encode(['bytes32'], [pid]).slice(2) });
  const r1 = await p.call({ to: S, data: liq + c.encode(['bytes32'], [pid]).slice(2) });
  const [sqrtP, tick, pFee, lpFee] = c.decode(['uint160', 'int24', 'uint24', 'uint24'], r0);
  const [l] = c.decode(['uint128'], r1);
  console.log(name, 'sqrt:', sqrtP.toString(), 'tick:', tick, 'liq:', l.toString(), 'feePpm:', lpFee);
}
await check('0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362', 'v4-25pct');
await check('0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326', 'v4-10pct');
process.exit(0);
