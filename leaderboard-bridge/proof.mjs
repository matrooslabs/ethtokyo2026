import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeAbiParameters, decodeAbiParameters, toHex, sha256, concat, encodePacked, recoverAddress } from 'viem';
const exec=promisify(execFile);
export const headerFields=[['chainId','uint64'],['verifier','address'],['matchId','bytes32'],['sessionId','bytes32'],['challenge','bytes32'],['player','address'],['device','address'],['chartHash','bytes32'],['rulesetId','bytes32'],['bitstreamHash','bytes32'],['inputPolicyHash','bytes32']];
export const headerABI=h=>encodeAbiParameters(headerFields.map(([,type])=>({type})),headerFields.map(([name])=>h[name]));
export function rustHeader(h){return Object.fromEntries(headerFields.map(([name,type])=>[name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),type==='uint64'?Number(h[name]):[...Buffer.from(h[name].slice(2),'hex')]]));}
export function eventBytes(events){return concat(events.map(e=>encodePacked(['uint32','uint64','uint8','uint8'],[e.sequence,BigInt(e.timestamp_us),e.lane,e.action])));}
export function traceRoot(id,events){let root=sha256(concat([toHex('OSUMANIA_TRACE_V1'),id]));for(let i=0;i<events.length;i+=32){const chunk=events.slice(i,i+32);root=sha256(concat([root,encodePacked(['uint32','uint16'],[i/32,chunk.length]),eventBytes(chunk)]));}return root;}
export function sessionDigest(h,n,duration,root){return sha256(concat([toHex('OSUMANIA_HARDWARE_SESSION_V1'),toHex(1,{size:2}),encodePacked(headerFields.map(([,t])=>t),headerFields.map(([n,t])=>t==='uint64'?BigInt(h[n]):h[n])),encodePacked(['uint32','uint64','bytes32'],[n,BigInt(duration),root])]));}
export async function prove({binary,srs,input,header,sealed=false,signal}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'leaderboard-proof-'));
 try{const file=path.join(dir,'play.json');await fs.writeFile(file,JSON.stringify(input));
 const args=[sealed?'prove-sealed':'prove-session','--srs',srs,'--input',file,'--mode','a'];if(header)args.push('--header',headerABI(header));
 const {stdout}=await exec(binary,args,{maxBuffer:32*1024*1024,timeout:600000,signal});
 const [words]=decodeAbiParameters([{type:'uint256[]'}],stdout.trim());
 if(words.length<16)throw Error('Invalid prover response');
 return {sub:{duration:words[13],laneBits:words.slice(0,4).map(Number),counts:words.slice(4,9).map(Number)},digest:toHex(words[11],{size:32}),n:Number(words[12]),root:toHex(words[14],{size:32}),proof:words.slice(15),events:eventBytes(input.events)};
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
export async function validateSeal(header,input,signature){
 const canonical=rustHeader(header);if(Object.keys(canonical).some(k=>JSON.stringify(input.header?.[k])!==JSON.stringify(canonical[k])))throw Error('Hardware header differs from paid session');
 if(input.footer.event_count!==input.events.length)throw Error('Hardware event count mismatch');
 const root=traceRoot(header.sessionId,input.events);
 if(toHex(Uint8Array.from(input.footer.trace_root))!==root)throw Error('Hardware trace root mismatch');
 const digest=sessionDigest(header,input.events.length,input.footer.duration_us,root);
 if((await recoverAddress({hash:digest,signature})).toLowerCase()!==header.device.toLowerCase())throw Error('Hardware signature mismatch');return digest;
}
