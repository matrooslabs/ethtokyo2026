import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createPublicClient,createWalletClient,http,defineChain,parseEventLogs,concat,encodePacked,toHex,sha256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {eventBytes,traceRoot,headerFields} from '../proof.mjs';
import {parseOsu,canonicalChartHash} from '../chart.mjs';
// Test keys and simulated device exist only in this opt-in, isolated Anvil test.
test('Mode B paid entry -> original signed capture -> HTTP proof -> wallet submission, restart and conflict recovery', {skip:process.env.SCORING_E2E!=='1',timeout:180000},async()=>{
 const root=path.resolve(import.meta.dirname,'../../..'),rpc=process.env.E2E_RPC||'http://127.0.0.1:19549';
 const chain=defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
 const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
 const device=privateKeyToAccount(`0x${'00'.repeat(31)}4d`);
 const pc=createPublicClient({chain,transport:http(rpc)}),wallet=createWalletClient({chain,account,transport:http(rpc)});
 assert.equal(await pc.getChainId(),31337);
 const artifact=name=>JSON.parse(fs.readFileSync(path.join(root,`scoring/gkr-scoring/contracts/out/${name}.sol/${name}.json`)));
 async function deploy(name,args=[]){const a=artifact(name);const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const r=await pc.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return {address:r.contractAddress,abi:a.abi};}
 async function write(c,functionName,args){const {request}=await pc.simulateContract({...c,functionName,args,account});const hash=await wallet.writeContract(request);const r=await pc.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;}
 const vk=JSON.parse(fs.readFileSync(path.join(root,'scoring/gkr-scoring/artifacts/forge/vk.json')));
 const relation=await deploy('GkrRelation');const verifier=await deploy('GkrScoreVerifier',[relation.address,BigInt(vk.smax),vk.g2One.map(BigInt),vk.g2Tau.map(BigInt),Array.from({length:vk.g2Shift.length/4},(_,i)=>vk.g2Shift.slice(i*4,i*4+4).map(BigInt))]);
 const registry=await deploy('ManiaGkrRegistry',[verifier.address]),token=await deploy('DemoUSDC'),board=await deploy('DailyLeaderboard',[token.address,registry.address]);
 await write(registry,'setLeaderboard',[board.address]);
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'scoring/gkr-scoring/artifacts/forge/case-demo-b.json')));
 await write(registry,'registerChart',[fixture.chart.bytes,fixture.chart.commitment.map(BigInt),fixture.chart.proof.map(BigInt)]);
 const bitstream=toHex(123,{size:32});await write(registry,'setDevice',[device.address,bitstream,true]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mode-b-e2e-'));let child;
 try {
 const osu=Buffer.from('osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,1,0\n192,192,1500,128,0,2000:0:0:0:0:\n320,192,1500,1,0\n448,192,2500,1,0\n');
 const chart=parseOsu(osu),chartHash=canonicalChartHash(chart.chart);assert.equal(chartHash,fixture.chart.chartHash);
 const osuFile=path.join(dir,'chart.osu');fs.writeFileSync(osuFile,osu);
 const manifest={chainId:31337,srsId:vk.srsId,token:token.address,contracts:{ManiaGkrRegistry:registry.address,DailyLeaderboard:board.address,GkrScoreVerifier:verifier.address}};
 const manifestFile=path.join(dir,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const binary=path.join(root,'scoring/target/release/mania-gkr-prove-server'),srs=path.join(root,'scoring/gkr-scoring/artifacts/dev-srs-22.bin');
 const hardwareSrs={...JSON.parse(execFileSync(binary,['--srs',srs,'--hardware-bank-points','260'],{encoding:'utf8'})),developmentOnly:true};
 const config={manifest:manifestFile,rpcUrl:rpc,allowedOrigins:['http://localhost:3000'],confirmations:1,provingBufferSeconds:180,provingBufferMeasured:true,charts:[{osuFile,chartHash,device:device.address}],jobStoreFile:path.join(dir,'jobs.json'),hardwareSrs};
 const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
 async function launch(){child=spawn(binary,['--srs',srs,'--bind','127.0.0.1:19550','--competition-config',configFile,'--project-root',root],{stdio:['ignore','pipe','pipe'],env:{...process.env,PROVER_API_TOKEN:undefined,SCORING_CONFIG:undefined}});await new Promise((resolve,reject)=>{let output='';child.stderr.on('data',b=>{output+=b;if(output.includes('GKR prove server on'))resolve();});child.once('exit',()=>reject(Error(output)));});}
 async function stop(){if(child){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;child=undefined;}}
 const badConfig=path.join(dir,'bad-bank.json');fs.writeFileSync(badConfig,JSON.stringify({...config,hardwareSrs:{...hardwareSrs,bankHash:toHex(0,{size:32})}}));
 assert.throws(()=>execFileSync(binary,['--srs',srs,'--bind','127.0.0.1:19550','--competition-config',badConfig,'--project-root',root],{stdio:'pipe'}),/pinned G1 bank hash mismatch/);
 await launch();
 const base='http://127.0.0.1:19550';async function req(route,body,origin){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
 assert.equal((await req(`/charts/${chart.webBeatmapHash}`)).body.ready,true);
 assert.equal((await req(`/charts/${chart.webBeatmapHash}`,undefined,'https://evil.example')).status,403);
 await write(token,'mint',[account.address,1000000n]);await write(token,'approve',[board.address,1000000n]);
 const day=await pc.readContract({...board,functionName:'currentDay'}),entry=await write(board,'enter',[chartHash,account.address,device.address,day]);
 const id=parseEventLogs({abi:board.abi,eventName:'EntryPaid',logs:entry.logs})[0].args.sessionId;
 const session=await pc.readContract({...registry,functionName:'getSession',args:[id]});assert.equal(session.mode,2);
 const attempt={sessionId:id,entryTxHash:entry.transactionHash,player:account.address,chartHash,dayId:Number(day),webBeatmapHash:chart.webBeatmapHash,captureMode:'hardware',chainId:31337,registry:registry.address};
 assert.equal((await req(`/sessions/${id}/start`,{...attempt,player:device.address})).status,400);
 const start=await req(`/sessions/${id}/start`,attempt);assert.equal(start.status,200,JSON.stringify(start.body));
 const h=session.header,packed=encodePacked(headerFields.map(([,t])=>t),headerFields.map(([n,t])=>t==='uint64'?BigInt(h[n]):h[n]));assert.equal(start.body.header,packed);
 const input=JSON.parse(fs.readFileSync(path.join(root,'scoring/fixtures/demo.json'))),n=input.events.length,duration=input.footer.duration_us,rootHash=traceRoot(id,input.events),tc=fixture.traceCommitment;
 const unsigned=concat([packed,encodePacked(['uint32','uint64','bytes32','uint256','uint256'],[n,BigInt(duration),rootHash,...tc.map(BigInt)])]);
 const digest=sha256(concat([toHex('OSUMANIA_HARDWARE_SESSION_V2'),toHex(2,{size:2}),unsigned]));
 const signature=await device.sign({hash:digest}),capture={result:concat([unsigned,signature]),trace:eventBytes(input.events),webBeatmapHash:chart.webBeatmapHash};
 const proof=await req(`/sessions/${id}/proof`,capture);assert.equal(proof.status,202,JSON.stringify(proof.body));
 assert.equal((await req(`/sessions/${id}/proof`,capture)).body.jobId,proof.body.jobId);
 assert.equal((await req(`/sessions/${id}/proof`,{...capture,trace:'0x'})).status,400);
 let job;for(let i=0;i<200;i++){job=(await req(`/jobs/${proof.body.jobId}`)).body;if(['ready','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(job.status,'ready',JSON.stringify(job));assert.equal(job.result.sessionDigest,digest);
 await stop();await launch();assert.deepEqual((await req(`/jobs/${proof.body.jobId}`)).body.result.submission,job.result.submission);
 const sub=job.result.submission,args=[id,sub.eventCount,sub.root,sub.commitment.map(BigInt),{duration:BigInt(sub.duration),laneBits:sub.laneBits,counts:sub.counts},sub.proof.map(BigInt),sub.signature];
 const receipt=await write(registry,'submitCommitted',args);
 assert.equal(parseEventLogs({abi:board.abi,eventName:'ScoreRecorded',logs:receipt.logs})[0].args.score,987500);
 assert.equal((await pc.readContract({...registry,functionName:'getSession',args:[id]})).consumed,true);
 await assert.rejects(pc.simulateContract({...registry,functionName:'submitCommitted',args,account}));
 console.log(JSON.stringify({sessionId:id,transactionHash:receipt.transactionHash,score:987500,proofTimings:job.result.timings}));
 await stop();
 } finally {if(child){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}fs.rmSync(dir,{recursive:true,force:true});}
});
