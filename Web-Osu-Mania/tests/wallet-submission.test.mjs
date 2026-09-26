import test from 'node:test';import assert from 'node:assert/strict';
import {submitAndConfirm} from '../src/lib/leaderboard/walletSubmission.ts';
function context(overrides={}) { const writes=[];let sends=0;return {writes,get sends(){return sends},io:{send:async()=>{sends++;return '0x01'},persist:async r=>writes.push(structuredClone(r)),wait:async hash=>({transactionHash:hash,status:'success'}),accepted:async()=>true,score:()=>987500,...overrides}}; }
test('wallet rejection and wrong-network errors retain proof and request no receipt',async()=>{
 for(const error of ['Wallet rejected','Wrong network']) {const record={proof:{words:[1]},capture:{original:true}},before=structuredClone(record);const c=context({send:async()=>{throw Error(error)},wait:async()=>assert.fail('must not wait')});await assert.rejects(submitAndConfirm(record,c.io),new RegExp(error));assert.deepEqual(record,before);assert.equal(c.writes.length,0);}
});
test('known pending hash reconciles without another wallet request, including replacement',async()=>{const record={proof:{words:[1]},transactionHash:'0x01'};const c=context({wait:async(hash,replaced)=>{assert.equal(hash,'0x01');replaced('0x02');return {transactionHash:'0x02',status:'success'}}});assert.equal(await submitAndConfirm(record,c.io),987500);assert.equal(c.sends,0);assert.equal(record.transactionHash,'0x02');assert.equal(c.writes.at(-1).transactionHash,'0x02');});
test('pending timeout keeps known hash for refresh recovery',async()=>{const record={proof:{words:[1]}};const c=context({wait:async()=>{throw Error('timeout')}});await assert.rejects(submitAndConfirm(record,c.io),/timeout/);assert.equal(record.transactionHash,'0x01');assert.equal(c.writes[0].transactionHash,'0x01');});
test('reverted or cancelled transaction preserves proof and enables retry',async()=>{
 for(const status of ['reverted','success']){const record={proof:{words:[1]},transactionHash:'0x01'};const c=context({wait:async()=>({transactionHash:'0x02',status}),score:()=>{throw Error('No accepted score')},accepted:async()=>false});await assert.rejects(submitAndConfirm(record,c.io));assert.equal(record.transactionHash,undefined);assert.deepEqual(record.proof,{words:[1]});}
});
test('accepted event without consumed session never reports success',async()=>{const c=context({accepted:async()=>false});await assert.rejects(submitAndConfirm({proof:{}},c.io),/disagree/);});
