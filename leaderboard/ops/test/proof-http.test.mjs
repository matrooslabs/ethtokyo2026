import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {decodeAbiParameters, toHex} from 'viem';
import {prove, proverInfo, headerFields, rustHeader, traceRoot, sessionDigest, eventBytes} from '../proof.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../../scoring/fixtures/demo.json', import.meta.url)));
const header = Object.fromEntries(headerFields.map(([key, type]) => {
 const value = fixture.header[key.replace(/[A-Z]/g, c => '_'+c.toLowerCase())];
 return [key, type === 'uint64' ? BigInt(value) : toHex(Uint8Array.from(value))];
}));
const srsId = toHex(1n, {size:32});
const token = 'http-test-token-at-least-32-characters';
function response(play) {
 return {mode:'Calldata', srsId, laneBits:[2,2,2,2], counts:[1,2,3,4,5], proof:[toHex(123n,{size:32})], sessionDigest:sessionDigest(header, play.events.length, play.footer.duration_us, traceRoot(header.sessionId, play.events))};
}
async function server(t, handle) {
 const server = createServer(async (req,res) => {
  let body=''; for await (const chunk of req) body+=chunk;
  const reply=handle(req, body ? JSON.parse(body) : undefined);
  res.writeHead(reply.status || 200, {'content-type':'application/json'});
  res.end(reply.raw ?? JSON.stringify(reply.body));
 });
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(async () => { const closed=once(server,'close'); server.close(); server.closeAllConnections(); await closed; });
 return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP client authenticates, preserves hardware input, and maps contract arguments', async t => {
 let sent;
 const url=await server(t,(req,body) => {
  assert.equal(req.headers.authorization,`Bearer ${token}`);
  if(req.url==='/v1/info') return {body:{system:'gkr',srsId,modes:['calldata','committed']}};
  assert.equal(req.url,'/v1/prove'); assert.equal(body.mode,'calldata'); sent=body.input;
  return {body:response(sent)};
 });
 const options={url,token,expectedSrsId:srsId};
 await proverInfo(options);
 const before=structuredClone(fixture);
 const result=await prove({...options,input:fixture,header,sealed:true});
 assert.deepEqual(sent,before); assert.deepEqual(fixture,before);
 assert.deepEqual(result.sub,{duration:BigInt(fixture.footer.duration_us),laneBits:[2,2,2,2],counts:[1,2,3,4,5]});
 assert.deepEqual(result.proof,[123n]); assert.equal(result.events,eventBytes(fixture.events));
 assert.equal(result.n,fixture.events.length); assert.equal(result.root,traceRoot(header.sessionId,fixture.events));
});

test('only software input can be rebound to a different paid session', async t => {
 const changed={...header,sessionId:toHex(88n,{size:32}),challenge:toHex(99n,{size:32})};
 let calls=0;
 const url=await server(t,(_req,body) => {
  calls++; assert.deepEqual(body.input.header,rustHeader(changed));
  const root=traceRoot(changed.sessionId,fixture.events);
  assert.equal(toHex(Uint8Array.from(body.input.footer.trace_root)),root);
  return {body:{...response(body.input),sessionDigest:sessionDigest(changed,fixture.events.length,fixture.footer.duration_us,root)}};
 });
 const options={url,expectedSrsId:srsId,input:fixture,header:changed};
 const before=structuredClone(fixture);
 await prove(options); assert.deepEqual(fixture,before);
 await assert.rejects(prove({...options,sealed:true}),/Hardware header/);
 const tampered=structuredClone(fixture);tampered.events[0].timestamp_us++;
 await assert.rejects(prove({...options,input:tampered,header,sealed:true}),/trace seal/);
 assert.equal(calls,1);
});

test('rejects unavailable servers, invalid JSON, wrong proof mode, session, SRS, and malformed words', async t => {
 let reply;
 const url=await server(t,()=>reply);
 const options={url,expectedSrsId:srsId,input:fixture,header,sealed:true};
 for(const status of [401,422,503,500]) {
  reply={status,body:{error:'not ready'}};
  await assert.rejects(prove(options),new RegExp(`HTTP ${status}`));
 }
 reply={raw:'not json'}; await assert.rejects(prove(options),/Invalid scoring server JSON/);
 for(const override of [{mode:'Committed'},{sessionDigest:toHex(2n,{size:32})},{srsId:toHex(2n,{size:32})},{proof:['nope']},{counts:[1]},{laneBits:[-1,0,0,0]}]) {
  reply={body:{...response(fixture),...override}};
  await assert.rejects(prove(options));
 }
 await assert.rejects(prove({...options,signal:AbortSignal.abort()}));
});

test('readiness rejects a Sui server or a different deployment SRS', async t => {
 let info={system:'gkr-sui',srsId,modes:['calldata']};
 const url=await server(t,()=>({body:info}));
 await assert.rejects(proverInfo({url,expectedSrsId:srsId}),/EVM calldata/);
 info={system:'gkr',srsId:toHex(2n,{size:32}),modes:['calldata']};
 await assert.rejects(proverInfo({url,expectedSrsId:srsId}),/SRS/);
});

test('real scoring HTTP server produces the same submission as the sealed CLI', {skip:process.env.PROVER_HTTP_INTEGRATION!=='1',timeout:120000}, async t => {
 const root=path.resolve(import.meta.dirname,'../../..');
 const dir=mkdtempSync(path.join(tmpdir(),'scoring-http-test-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const srs=path.join(dir,'srs.bin');
 const binary=path.join(root,'scoring/target/release/mania-gkr');
 execFileSync(binary,['srs','--smax','16','--out',srs]);
 const serverEnv={...process.env,PROVER_API_TOKEN:token}; delete serverEnv.SCORING_CONFIG;
 const child=spawn(path.join(root,'scoring/target/release/mania-gkr-prove-server'),['--bind','127.0.0.1:0','--srs',srs],{env:serverEnv,stdio:['ignore','ignore','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}});
 const url=await new Promise((resolve,reject)=>{
  let output='';child.on('error',reject);child.once('exit',()=>reject(Error('Scoring server exited before ready')));
  child.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
 });
 const info=await (await fetch(`${url}/v1/info`,{headers:{authorization:`Bearer ${token}`}})).json();
 const options={url,token,expectedSrsId:info.srsId};
 await proverInfo(options);
 const result=await prove({...options,input:fixture,header,sealed:true});
 const encoded=execFileSync(binary,['prove-sealed','--srs',srs,'--input',path.join(root,'scoring/fixtures/demo.json'),'--mode','a'],{encoding:'utf8'}).trim();
 const [words]=decodeAbiParameters([{type:'uint256[]'}],encoded);
 assert.deepEqual(result.sub,{duration:words[13],laneBits:words.slice(0,4).map(Number),counts:words.slice(4,9).map(Number)});
 assert.equal(result.digest,toHex(words[11],{size:32})); assert.equal(result.n,Number(words[12]));
 assert.equal(result.root,toHex(words[14],{size:32})); assert.deepEqual(result.proof,words.slice(15));
 const bad=structuredClone(fixture);bad.chart.notes[0].start_us++;
 await assert.rejects(prove({...options,input:bad,header,sealed:true}),/HTTP 422/);
});
