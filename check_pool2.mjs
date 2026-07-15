import { JsonRpcProvider, AbiCoder, dataSlice, keccak256, toUtf8Bytes, getAddress } from 'ethers';

const provider = new JsonRpcProvider('https://robinhood-mainnet.g.alchemy.com/v2/ob2KOYZOJxKNUvDj8Ts2v');
const POOL_MGR = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const coder = AbiCoder.defaultAbiCoder();

const poolKey = ['0x0000000000000000000000000000000000000000', '0x45c2a2462e4ffc37e9698b46361f0f6444544663', 250000, 5000, '0x0000000000000000000000000000000000000000'];
const poolId = keccak256(coder.encode(['(address,address,uint24,int24,address)'], [poolKey]));
console.log('Pool ID:', poolId);

// Try all known PoolManager functions
const sigs = [
  ['getSlot0', ['bytes32'], ['uint160','int24','uint24']],
  ['getLiquidity', ['bytes32'], ['uint128']],
  ['getProtocolFees', ['bytes32'], ['uint128','uint128']],
  ['getPosition', ['bytes32','address','bytes32'], ['uint128']],
  ['swap', ['bytes32','address','int256','bytes'], ['int256','int256']],
  ['initialize', ['(address,address,uint24,int24,address)','uint160','int24'], []],
];

async function main() {
  for (const [name, inputs, outputs] of sigs) {
    const sig = name + '(' + inputs.join(',') + ')';
    const selector = dataSlice(keccak256(toUtf8Bytes(sig)), 0, 4);
    const args = inputs.map(t => t === 'bytes32' ? poolId : t === '(address,address,uint24,int24,address)' ? poolKey : null);
    const data = selector + coder.encode(inputs, args).slice(2);
    try {
      const r = await provider.call({ to: POOL_MGR, data });
      if (r === '0x') { console.log(name + ': empty'); continue; }
      const dec = coder.decode(outputs, r);
      console.log(name + ': ' + dec.map(x => x.toString ? x.toString() : x).join(', '));
    } catch (err) {
      const d = err.data || '';
      console.log(name + ': revert ' + d.slice(0, 10));
    }
  }

  // Also check Quoter directly with a simpler call
  console.log('\n--- Direct Quoter test ---');
  const params = coder.encode(
    ['tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)'],
    [[poolKey, false, '1000000000000000000', '0x']]
  );
  const qSig = dataSlice(keccak256(toUtf8Bytes('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))')), 0, 4);
  try {
    await provider.call({ to: QUOTER, data: qSig + params.slice(2) });
  } catch (err) {
    const d = err.data || '';
    console.log('Quoter revert selector:', d.slice(0, 10));
  
    // Try to find what 47a5ed73 is
    const inner = d.slice(10).match(/.{1,64}/g)?.map(x => '0x' + x) || [];
    console.log('Inner data decoded:');
    if (inner.length >= 1) {
      const offset = BigInt(inner[0]);
      console.log('  offset:', offset.toString());
    }
    if (inner.length >= 2 + Number(BigInt(inner[0] || 0) / 32n)) {
      const dataIdx = 1 + Number(BigInt(inner[0] || 0) / 32n);
      console.log('  length:', inner[dataIdx]);
      const sel = inner[dataIdx + 1]?.slice(0, 10);
      console.log('  inner selector:', sel);
    }
  }
}

main().catch(console.error);
