// scripts/compile.js — compile contracts/ArbExecutor.sol -> build/ArbExecutor.json
import fs from 'node:fs';
import solc from 'solc';

fs.mkdirSync('build', { recursive: true });
const src = fs.readFileSync('contracts/ArbExecutor.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ArbExecutor.sol': { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
let hard = false;
for (const e of out.errors || []) { console.log(e.severity.toUpperCase(), e.formattedMessage.split('\n')[0]); if (e.severity === 'error') hard = true; }
const c = out.contracts?.['ArbExecutor.sol']?.ArbExecutor;
if (!c || hard) { console.error('COMPILE FAILED'); process.exit(1); }
fs.writeFileSync('build/ArbExecutor.json', JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
console.log('wrote build/ArbExecutor.json |', c.evm.bytecode.object.length / 2, 'bytes');
