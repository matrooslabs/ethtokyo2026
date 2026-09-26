import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {validateCapture,packHeader,policy} from '../src/lib/leaderboard/seal.ts';
const hash=b=>createHash('sha256').update(b).digest();
const hex=b=>`0x${b.toString('hex')}`;
export async function fixture(n=33){
 const signer=privateKeyToAccount(`0x${'00'.repeat(31)}4d`),word=`0x${'11'.repeat(32)}`,address=`0x${'22'.repeat(20)}`;
 const h={chainId:31337n,verifier:address,matchId:word,sessionId:word,challenge:word,player:address,device:signer.address,chartHash:word,rulesetId:word,bitstreamHash:word,inputPolicyHash:policy};
 const trace=Buffer.alloc(n*14);
 for(let i=0;i<n;i++){trace.writeUInt32BE(i,i*14);trace.writeBigUInt64BE(BigInt(i),i*14+4);trace[i*14+13]=i%2;}
 let root=hash(Buffer.concat([Buffer.from('OSUMANIA_TRACE_V1'),Buffer.from(word.slice(2),'hex')]));
 for(let i=0;i<n;i+=32){const prefix=Buffer.alloc(6);prefix.writeUInt32BE(i/32);prefix.writeUInt16BE(Math.min(32,n-i),4);root=hash(Buffer.concat([root,prefix,trace.subarray(i*14,Math.min(n,i+32)*14)]));}
 const header=packHeader(h),unsigned=Buffer.alloc(400);Buffer.from(header.slice(2),'hex').copy(unsigned);unsigned.writeUInt32BE(n,292);unsigned.writeBigUInt64BE(700000n,296);root.copy(unsigned,304);
 const digest=hex(hash(Buffer.concat([Buffer.from('OSUMANIA_HARDWARE_SESSION_V2'),Buffer.from([0,2]),unsigned])));
 const signature=await signer.sign({hash:digest});
 return {attempt:{chainId:31337,registry:address,sessionId:word},header,setup:{maxEnd:500000,hardwareSrs:{maxEvents:65}},capture:{result:hex(Buffer.concat([unsigned,Buffer.from(signature.slice(2),'hex')])),trace:hex(trace),webBeatmapHash:'test'}};
}
for(const n of [0,1,31,32,33,64,65])test(`original browser seal validation, ${n} events`,async()=>{const r=await fixture(n);assert.equal((await validateCapture(r.capture,r)).n,n);});
test('changed original signed fields, event timing, sequence, transitions, truncation and capacity fail',async()=>{
 const r=await fixture();
 for(const offset of [0,292,303,304,336,400,432,464]){const bytes=Buffer.from(r.capture.result.slice(2),'hex');bytes[offset]^=1;await assert.rejects(validateCapture({...r.capture,result:hex(bytes)},r));}
 for(const offset of [0,4,12,13,14+13]){const bytes=Buffer.from(r.capture.trace.slice(2),'hex');bytes[offset]^=1;await assert.rejects(validateCapture({...r.capture,trace:hex(bytes)},r));}
 await assert.rejects(validateCapture({...r.capture,trace:'0x'},r));
 await assert.rejects(validateCapture(r.capture,{...r,setup:{...r.setup,hardwareSrs:{maxEvents:32}}}));
});
