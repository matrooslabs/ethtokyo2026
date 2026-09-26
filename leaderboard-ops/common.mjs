import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoPath = p => path.resolve(root,p);
export const contracts = path.join(root, 'scoring/gkr-scoring/contracts');
export const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
export function save(p, value) { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p+'.tmp', json(value)+'\n', {mode:0o600}); fs.renameSync(p+'.tmp',p); }
export function artifact(name, source=name) { return readJSON(path.join(contracts,'out',`${source}.sol`,`${name}.json`)); }
export function clients() {
 const id = Number(process.env.CHAIN_ID || 11155111);
 if (![11155111,31337].includes(id)) throw Error('Only Sepolia or local Anvil supported');
 const rpc = process.env.RPC_URL || (id===31337?'http://127.0.0.1:8545':'https://ethereum-sepolia-rpc.publicnode.com');
 const chain = defineChain({id,name:id===31337?'Anvil':'Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
 const key = fs.readFileSync(repoPath(process.env.KEY_FILE || '.priv-key'),'utf8').trim();
 if(!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw Error('KEY_FILE must contain one hex private key');
 const account = privateKeyToAccount(key.startsWith('0x')?key:`0x${key}`);
 return {id,account,publicClient:createPublicClient({chain,transport:http(rpc)}),wallet:createWalletClient({chain,account,transport:http(rpc)})};
}
