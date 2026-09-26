import {createServer} from 'node:http';import {rustHeader,traceRoot,sessionDigest} from '../proof.mjs';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {createPublicClient,createWalletClient,http,defineChain,parseEventLogs,parseAbi} from 'viem';import {privateKeyToAccount} from 'viem/accounts';import {parseOsu,canonicalChartHash} from '../chart.mjs';
// Opt-in: uses an already deployed isolated Anvil, never a public network.
test(`HTTP paid ${process.env.E2E_CAPTURE_MODE==='hardware'?'hardware-adapter TEST DOUBLE':'software-demo'} flow with real Rust proof and chain acceptance`, {skip:process.env.BRIDGE_E2E!=='1',timeout:120000},async()=>{
 const root=path.resolve(import.meta.dirname,'../../..');const manifest=JSON.parse(fs.readFileSync(process.env.E2E_MANIFEST||path.join(root,'leaderboard/ops/deployments/31337.manifest.json')));assert.equal(manifest.chainId,31337);
 const rpc=process.env.E2E_RPC||'http://127.0.0.1:19549';const chain=defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
 const account=privateKeyToAccount(fs.readFileSync(process.env.E2E_KEY_FILE||'/tmp/daily-leaderboard-anvil.key','utf8').trim());const deviceKey=process.env.E2E_DEVICE_KEY_FILE||path.join(root,'leaderboard/ops/deployments/31337.software-device.key');const device=privateKeyToAccount(fs.readFileSync(deviceKey,'utf8').trim());
 const pc=createPublicClient({chain,transport:http(rpc)}),wallet=createWalletClient({chain,account,transport:http(rpc)});assert.equal(await pc.getChainId(),31337);
 fs.mkdirSync(path.join(root,'leaderboard/bridge/data'),{recursive:true});const dir=fs.mkdtempSync(path.join(root,'leaderboard/bridge/data/e2e-')); let child,adapter;const captureMode=process.env.E2E_CAPTURE_MODE==='hardware'?'hardware':'software-demo';
 try{
 const osu=Buffer.from('osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[Metadata]\nTitle:Daily bridge test\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n192,192,1500,128,0,2000:0:0:0:0:\n320,192,1500,1,0,0:0:0:0:\n448,192,2500,1,0,0:0:0:0:\n');const chart=parseOsu(osu),chartHash=canonicalChartHash(chart.chart);const osuFile=path.join(dir,'test.osu');fs.writeFileSync(osuFile,osu);
 const board=manifest.contracts.DailyLeaderboard,registry=manifest.contracts.ManiaGkrRegistry,babi=manifest.abi.DailyLeaderboard,rabi=manifest.abi.ManiaGkrRegistry;
 async function write(address,abi,functionName,args){const hash=await wallet.writeContract({address,abi,functionName,args});const r=await pc.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;}
 const tokenABI=parseAbi(['function mint(address,uint256)','function approve(address,uint256) returns(bool)']);await write(manifest.token,tokenABI,'mint',[account.address,1000000n]);await write(manifest.token,tokenABI,'approve',[board,1000000n]);
 const day=await pc.readContract({address:board,abi:babi,functionName:'currentDay'});const entry=await write(board,babi,'enter',[chartHash,account.address,device.address,day]);const event=parseEventLogs({abi:babi,eventName:'EntryPaid',logs:entry.logs})[0];assert.ok(event);const id=event.args.sessionId;
 if(captureMode==='hardware'){
  let header,sealCalls=0;const fixture=JSON.parse(fs.readFileSync(path.join(root,'scoring/fixtures/demo.json')));
  adapter=createServer(async(req,res)=>{let data='';for await(const b of req)data+=b;res.setHeader('content-type','application/json');
   if(req.url==='/health')return res.end(JSON.stringify({ready:true,device:device.address}));
   if(req.url.endsWith('/start')){header=JSON.parse(data).header;return res.end('{}');}
   if(req.url.endsWith('/seal')){if(sealCalls++===0){res.writeHead(503);return res.end('{}');}const rootHash=traceRoot(header.sessionId,fixture.events);const input={...fixture,header:rustHeader(header),footer:{...fixture.footer,trace_root:[...Buffer.from(rootHash.slice(2),'hex')]}};const digest=sessionDigest(header,input.events.length,input.footer.duration_us,rootHash);const signature=await device.sign({hash:digest});return res.end(JSON.stringify({input,signature}));}
   res.writeHead(404);res.end('{}');
  });await new Promise(r=>adapter.listen(19551,'127.0.0.1',r));
 }
 const config={jobStoreFile:path.join(dir,'jobs.json'),manifest:process.env.E2E_MANIFEST||'leaderboard/ops/deployments/31337.manifest.json',rpcUrl:rpc,port:19550,allowedOrigins:[],captureMode,hardwareUrl:'http://127.0.0.1:19551',demoDeviceKeyFile:deviceKey,relayerKeyFile:process.env.E2E_KEY_FILE||'/tmp/daily-leaderboard-anvil.key',provingBufferSeconds:180,provingBufferMeasured:true,charts:[{osuFile:path.relative(root,osuFile),chartHash,device:device.address}]};const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
 async function launch(){let stderr='';child=spawn('npm',['start','--prefix',path.join(root,'leaderboard/bridge')],{cwd:os.tmpdir(),detached:true,env:{...process.env,BRIDGE_CONFIG:path.relative(root,configFile)},stdio:['ignore','pipe','pipe']});child.stderr.on('data',b=>stderr+=b);await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{if(b.toString().includes('Leaderboard bridge listening'))resolve();});child.once('exit',()=>reject(Error(stderr)));});}
 async function stop(){if(!child)return;const ended=new Promise(r=>child.once('exit',r));process.kill(-child.pid,'SIGTERM');await ended;child=null;}
 await launch();
 const base='http://127.0.0.1:19550';const get=async route=>{const r=await fetch(base+route);return {status:r.status,body:await r.json()};};const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const ready=await get(`/charts/${chart.webBeatmapHash}`);assert.equal(ready.body.ready,true,JSON.stringify(ready.body));assert.equal(ready.body.chartHash,chartHash);
 const paid={sessionId:id,entryTxHash:entry.transactionHash,player:account.address,chartHash,dayId:Number(day),webBeatmapHash:chart.webBeatmapHash,captureMode};
 assert.equal((await post(`/sessions/${id}/start`,{...paid,player:device.address})).status,400);
 assert.equal((await post(`/sessions/${id}/start`,paid)).status,200);
 const replay={version:2,mods:{bits:0,rate:1},inputs:[[0,1000,true],[0,1000.001,false],[2,1500,true],[2,1500.001,false],[1,1510,true],[1,2030,false],[3,2500,true],[3,2500.001,false]]};
 if(captureMode==='software-demo')assert.equal((await post(`/sessions/${id}/proof`,{replay,timing:{chartDelayMs:42},webBeatmapHash:chart.webBeatmapHash})).status,400);
 let proof=await post(`/sessions/${id}/proof`,{replay,timing:{chartDelayMs:0},webBeatmapHash:chart.webBeatmapHash});assert.equal(proof.status,202,JSON.stringify(proof.body));
 if(captureMode==='hardware'){
  let failed;for(let i=0;i<20;i++){failed=(await get(`/jobs/${proof.body.jobId}`)).body;if(failed.status==='failed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(failed.status,'failed');assert.equal(failed.retryable,true);assert.equal(failed.transactionHash,undefined);
  const previousId=proof.body.jobId;const payload={replay,timing:{chartDelayMs:0},webBeatmapHash:chart.webBeatmapHash};
  assert.equal((await post(`/sessions/${id}/proof`,payload)).body.jobId,previousId);
  proof=await post(`/sessions/${id}/proof`,{...payload,retry:true});assert.equal(proof.status,202);assert.notEqual(proof.body.jobId,previousId);
 }
 let job;for(let i=0;i<120;i++){job=(await get(`/jobs/${proof.body.jobId}`)).body;if(['failed','confirmed'].includes(job.status))break;await new Promise(r=>setTimeout(r,500));}assert.equal(job.status,'confirmed',JSON.stringify(job));
 const recorded=await pc.readContract({address:board,abi:babi,functionName:'entries',args:[id]});assert.equal(recorded[4],true);
 const record=await pc.readContract({address:board,abi:babi,functionName:'records',args:[chartHash,day,account.address]});assert.equal(record[0],true);assert.equal(record[1],987500);
 await stop();await launch();const resumed=(await get(`/jobs/${proof.body.jobId}`)).body;assert.equal(resumed.status,'confirmed',JSON.stringify(resumed));assert.equal(resumed.transactionHash,job.transactionHash);
 console.log(JSON.stringify({bridgeE2E:true,sessionId:id,transactionHash:job.transactionHash,score:record[1]}));
 }finally{if(child){const ended=new Promise(r=>child.once('exit',r));process.kill(-child.pid,'SIGTERM');await ended;}adapter?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
