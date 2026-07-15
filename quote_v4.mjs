import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes, formatEther, parseEther } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const provider = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const STATE = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

const POOLS = [
  { name: 'v4-25pct', id: '0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362' },
  { name: 'v4-10pct', id: '0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326' },
];

async function main() {
  for (const pool of POOLS) {
    const s0 = dataSlice(keccak256(toUtf8Bytes('getSlot0(bytes32)')), 0, 4);
    const r0 = await provider.call({ to: STATE, data: s0 + coder.encode(['bytes32'], [pool.id]).slice(2) });
    const [sqrtP, tick, pFee, lpFee] = coder.decode(['uint160', 'int24', 'uint24', 'uint24'], r0);

    const liqSig = dataSlice(keccak256(toUtf8Bytes('getLiquidity(bytes32)')), 0, 4);
    const r1 = await provider.call({ to: STATE, data: liqSig + coder.encode(['bytes32'], [pool.id]).slice(2) });
    const [liq] = coder.decode(['uint128'], r1);

    // Fee: lpFee is in parts per million. Convert to basis points.
    const feeBps = Number(lpFee) / 100;
    console.log(`\n${pool.name}:`);
    console.log(`  sqrtPriceX96: ${sqrtP}`);
    console.log(`  tick: ${tick}`);
    console.log(`  liquidity: ${liq}`);
    console.log(`  fee: ${lpFee} ppm = ${feeBps} bps = ${feeBps/100}%`);

    // Price calculation:
    // sqrtPriceX96 = sqrt(price) * 2^96
    // price = sqrtPriceX96^2 / 2^192
    // price is amount of token1 (RH6900) per token0 (ETH)
    const Q96 = 1n << 96n;
    const Q192 = Q96 * Q96;
    const sqrtP_big = BigInt(sqrtP);
    const price_x1e18 = sqrtP_big * sqrtP_big * parseEther('1') / Q192;
    console.log(`  ETH/RH6900 price: 1 RH6900 = ${formatEther(price_x1e18)} ETH`);

    // Quote: sell 1 RH6900 for ETH (zeroForOne=false)
    const amountIn = parseEther('1');
    const amountAfterFee = amountIn * BigInt(10000 - feeBps) / 10000n;
    // For zeroForOne=false (sell token1): 
    // amount0_out = amount1_in * feeFactor * 2^192 / sqrtPrice^2
    const quoteSell = amountAfterFee * Q192 / (sqrtP_big * sqrtP_big);
    console.log(`  Quote sell: 1 RH6900 → ${formatEther(quoteSell)} ETH (${feeBps} bps fee)`);

    // Quote: buy 1 RH6900 with ETH (zeroForOne=true)
    const buyAmount = parseEther('1');
    const buyAfterFee = buyAmount * BigInt(10000 - feeBps) / 10000n;
    // For zeroForOne=true (sell token0):
    // amount1_out = amount0_in * feeFactor * sqrtPrice^2 / 2^192
    const quoteBuy = buyAfterFee * sqrtP_big * sqrtP_big / Q192;
    console.log(`  Quote buy: 1 ETH → ${formatEther(quoteBuy)} RH6900`);
  }
}
main().catch(console.error);
