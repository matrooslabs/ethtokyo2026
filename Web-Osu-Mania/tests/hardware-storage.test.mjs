import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {build} from 'esbuild';import {chromium} from 'playwright';
import path from 'node:path';
test('Chromium IndexedDB survives refresh, retains proof/pending hash, isolates deployments and rejects capture replacement',async()=>{
 const {outputFiles}=await build({entryPoints:[path.resolve(import.meta.dirname,'../src/lib/leaderboard/captureStore.ts')],bundle:true,write:false,format:'iife',globalName:'captureStore',platform:'browser'});
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<script>${outputFiles[0].text}</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try {
 browser=await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const attempt={chainId:31337,registry:'0x1111',sessionId:'0x2222',player:'0x3333'},record={attempt,header:'0x1234',capture:{result:'0xab',trace:'0xcd',webBeatmapHash:'source'},proof:{sessionDigest:'0xee'},transactionHash:'0xff'};
 await page.evaluate(r=>window.captureStore.save(r),record);await page.reload();
 assert.deepEqual(await page.evaluate(a=>window.captureStore.saved(a),attempt),record);
 assert.equal(await page.evaluate(a=>window.captureStore.saved({...a,chainId:1}),attempt),undefined);
 assert.equal(await page.evaluate(a=>window.captureStore.saved({...a,registry:'0x4444'}),attempt),undefined);
 await assert.rejects(page.evaluate(r=>window.captureStore.save({...r,capture:{...r.capture,trace:'0x00'}}),record),/immutable capture/);
 assert.deepEqual(await page.evaluate(a=>window.captureStore.saved(a),attempt),record);
 await page.evaluate(async a=>{const r=await window.captureStore.saved(a);delete r.transactionHash;await window.captureStore.save(r);},attempt);
 await page.reload();const retried=await page.evaluate(a=>window.captureStore.saved(a),attempt);assert.deepEqual(retried.proof,record.proof);assert.deepEqual(retried.capture,record.capture);assert.equal(retried.transactionHash,undefined);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
