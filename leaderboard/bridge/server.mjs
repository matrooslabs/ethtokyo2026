import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPublicClient,createWalletClient,http as transport,defineChain,parseEventLogs,toHex,zeroAddress,recoverAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {parseOsu,replayEvents,canonicalChartHash} from './chart.mjs';
import {localAccess} from './local-access.mjs';
import {prove,rustHeader,traceRoot,validateSeal,sessionDigest} from './proof.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const repoPath=p=>path.resolve(root,p);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const cfg=read(repoPath(process.env.BRIDGE_CONFIG || 'leaderboard/bridge/config.json'));
const access=localAccess(cfg);
const manifest=read(repoPath(cfg.manifest));
const chain=defineChain({id:manifest.chainId,name:'Leaderboard',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[cfg.rpcUrl]}}});
const pc=createPublicClient({chain,transport:transport(cfg.rpcUrl)});
const readAccount=p=>{const key=fs.readFileSync(repoPath(p),'utf8').trim();if(!/^(0x)?[0-9a-fA-F]{64}$/.test(key))throw Error('Signer file must contain one hex private key');try{return privateKeyToAccount(key.startsWith('0x')?key:`0x${key}`);}catch{throw Error('Invalid signer private key');}};
const relayer=cfg.relayerKeyFile?readAccount(cfg.relayerKeyFile):null;
const wallet=relayer?createWalletClient({chain,account:relayer,transport:transport(cfg.rpcUrl)}):null;
const demo=cfg.captureMode==='software-demo'?readAccount(cfg.demoDeviceKeyFile):null;
if(demo && relayer?.address===demo.address)throw Error('Demo device key must differ from relayer/deployer key');
if(!['hardware','software-demo'].includes(cfg.captureMode))throw Error('Choose hardware or explicit software-demo mode');
const board=manifest.contracts.DailyLeaderboard,registry=manifest.contracts.ManiaGkrRegistry;
const boardABI=manifest.abi.DailyLeaderboard,registryABI=manifest.abi.ManiaGkrRegistry;
const charts=new Map((cfg.charts||[]).map(c=>{const parsed=parseOsu(fs.readFileSync(repoPath(c.osuFile)));if(canonicalChartHash(parsed.chart).toLowerCase()!==c.chartHash.toLowerCase())throw Error('Configured chart hash does not match .osu notes');return [parsed.webBeatmapHash,{...c,...parsed}];}));
const jobStore=repoPath(cfg.jobStoreFile||`leaderboard/bridge/data/jobs-${manifest.chainId}-${board.toLowerCase()}.json`);
const checkpoint=fs.existsSync(jobStore)?read(jobStore):{starts:[],jobs:[]};
const starts=new Map(checkpoint.starts),jobs=new Map(checkpoint.jobs);let busy=false;
function saveJobs(){fs.mkdirSync(path.dirname(jobStore),{recursive:true});fs.writeFileSync(jobStore+'.tmp',JSON.stringify({starts:[...starts],jobs:[...jobs]}),{mode:0o600});fs.renameSync(jobStore+'.tmp',jobStore);}
// Interrupted pre-broadcast work can be regenerated from the browser's saved replay.
// Submitted jobs retain their transaction hash and are reconciled instead of rebroadcast.
for(const start of starts.values()){const job=jobs.get(start.jobId);if(job&&!job.transactionHash&&!['confirmed','failed'].includes(job.status)){jobs.delete(start.jobId);delete start.jobId;}}
saveJobs();
async function reconcileJob(job){if(!job.transactionHash)return;const receipt=await pc.getTransactionReceipt({hash:job.transactionHash}).catch(()=>null);if(!receipt){job.status='submitting';return;}if(await pc.getBlockNumber()<receipt.blockNumber+BigInt((cfg.confirmations||1)-1)){job.status='submitting';return;}if(receipt.status==='reverted'){job.status='failed';job.message='Proof transaction reverted';}else if((await readContract(board,boardABI,'entries',[job.sessionId]))[4]){job.status='confirmed';delete job.message;}else{job.status='failed';job.message='Transaction did not record the paid score';}saveJobs();}

const binary=repoPath(cfg.proverBinary||'scoring/gkr-scoring/target/release/mania-gkr'),srs=repoPath(cfg.srsFile||'scoring/gkr-scoring/artifacts/dev-srs-22.bin');
const readContract=(address,abi,functionName,args)=>pc.readContract({address,abi,functionName,args});
const eq=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
async function adapter(route,body){if(!cfg.hardwareUrl)throw Error('Hardware capture adapter not configured');const r=await fetch(new URL(route,cfg.hardwareUrl),{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cfg.hardwareToken?{authorization:`Bearer ${cfg.hardwareToken}`}:{})},body:body?JSON.stringify(body,(_,v)=>typeof v==='bigint'?v.toString():v):undefined,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(`Hardware adapter rejected request (${r.status})`);return r.json();}
async function readiness(c){
 try{if(!Number.isFinite(cfg.provingBufferSeconds)||cfg.provingBufferSeconds<=0||cfg.provingBufferMeasured!==true)throw Error('Measure and configure proving buffer before paid play');if(await pc.getChainId()!==manifest.chainId)throw Error('RPC chain mismatch');if(!wallet)throw Error('Proof relayer not configured');fs.accessSync(binary,fs.constants.X_OK);fs.accessSync(srs,fs.constants.R_OK);
 const [linkedBoard,linkedRegistry,token,srsId]=await Promise.all([
 readContract(registry,registryABI,'leaderboard',[]),readContract(board,boardABI,'registry',[]),readContract(board,boardABI,'token',[]),readContract(manifest.contracts.GkrScoreVerifier,manifest.abi.GkrScoreVerifier,'srsId',[])]);
 if(!eq(linkedBoard,board)||!eq(linkedRegistry,registry)||!eq(token,manifest.token)||!eq(srsId,manifest.srsId))throw Error('Deployment wiring/SRS mismatch');
 const [ch,device]=await Promise.all([readContract(registry,registryABI,'getChart',[c.chartHash]),readContract(registry,registryABI,'devices',[c.device])]);if(!ch.registered)throw Error('Chart is not registered');if(!device[1])throw Error('Device is inactive');
 if(demo&&!eq(demo.address,c.device))throw Error('Demo signer does not match chart device');if(cfg.captureMode==='hardware'){const health=await adapter('/health');if(health.ready!==true||!eq(health.device,c.device))throw Error('Physical device unavailable');}
 return {ready:true};}catch(e){return {ready:false,reason:e.message};}}
async function bound(id,body){
 const [entry,session,block]=await Promise.all([readContract(board,boardABI,'entries',[id]),readContract(registry,registryABI,'getSession',[id]),pc.getBlock()]);
 if(entry[2]===zeroAddress||entry[4]||session.consumed||session.mode!==1||block.timestamp>=BigInt(session.expiresAt))throw Error('Unknown, expired or consumed paid session');
 if(!eq(entry[0],body.chartHash)||!eq(entry[3],body.player)||BigInt(entry[1])!==BigInt(body.dayId)||!eq(session.header.chartHash,entry[0])||!eq(session.header.player,entry[3]))throw Error('Paid session binding mismatch');
 const receipt=await pc.getTransactionReceipt({hash:body.entryTxHash});if(receipt.status!=='success'||block.number<receipt.blockNumber+BigInt((cfg.confirmations||1)-1))throw Error('Entry is not confirmed');
 const events=parseEventLogs({abi:boardABI,eventName:'EntryPaid',logs:receipt.logs.filter(l=>eq(l.address,board))});if(!events.some(e=>eq(e.args.sessionId,id)))throw Error('Entry receipt mismatch');return session;
}
async function submit(job,start,body){
 busy=true;try{job.status='proving';const session=await bound(start.sessionId,start);const chart=charts.get(start.webBeatmapHash);let input,signature,digest;
 if(cfg.captureMode==='hardware'){
  job.status='capturing';const sealed=await adapter(`/sessions/${start.sessionId}/seal`,{});input=sealed.input;signature=sealed.signature;
  if(JSON.stringify(input.chart)!==JSON.stringify(chart.chart))throw Error('Hardware chart differs from registered chart');
  digest=await validateSeal(session.header,input,signature);job.status='proving';
 }else{
  const events=replayEvents(body,chart);const duration=Math.max(chart.maxEnd+136500,...events.map(e=>e.timestamp_us));if(duration>1800000000)throw Error('Duration too long');
  input={header:rustHeader(session.header),chart:chart.chart,events,footer:{event_count:events.length,duration_us:duration,trace_root:[...Buffer.from(traceRoot(start.sessionId,events).slice(2),'hex')]}};
 }
 const result=await prove({binary,srs,input,header:session.header,sealed:cfg.captureMode==='hardware'});
 const expected=sessionDigest(session.header,input.events.length,input.footer.duration_us,traceRoot(start.sessionId,input.events));
 if(result.digest!==expected||result.n!==input.events.length||result.sub.duration!==BigInt(input.footer.duration_us)||result.root!==traceRoot(start.sessionId,input.events))throw Error('Prover output does not match captured session');
 if(demo)signature=await demo.sign({hash:result.digest});else if(result.digest!==digest)throw Error('Proof does not match hardware seal');
 await bound(start.sessionId,start);job.status='submitting';
 const args=[start.sessionId,result.events,result.sub,result.proof,signature];
 const gas=await pc.estimateContractGas({address:registry,abi:registryABI,functionName:'submitCalldata',args,account:relayer});const limit=gas*12n/10n;if(limit>16777216n)throw Error('Proof exceeds Sepolia transaction gas cap');
 const hash=await wallet.writeContract({address:registry,abi:registryABI,functionName:'submitCalldata',args,gas:limit});job.transactionHash=hash;saveJobs();
 const receipt=await pc.waitForTransactionReceipt({hash,confirmations:cfg.confirmations||1});if(receipt.status!=='success')throw Error('Proof transaction reverted');
 if(!(await readContract(board,boardABI,'entries',[start.sessionId]))[4])throw Error('Confirmed transaction did not record paid score');job.status='confirmed';
 }catch(e){job.status='failed';job.message=e.shortMessage||e.message;job.retryable=!job.transactionHash;}finally{busy=false;saveJobs();}}
function send(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body,(_,v)=>typeof v==='bigint'?v.toString():v));}
async function body(req){let data='';for await(const part of req){data+=part;if(data.length>8*1024*1024)throw Error('Request too large');}return JSON.parse(data||'{}');}
const server=http.createServer(async(req,res)=>{
 const denied=access.check(req);if(denied)return send(res,403,{error:denied});const origin=req.headers.origin;if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
 if(req.method==='OPTIONS'){res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('access-control-allow-headers','Content-Type');res.writeHead(204);return res.end();}
 try{const pathname=new URL(req.url,'http://localhost').pathname;let match;
 if(req.method==='GET'&&(match=pathname.match(/^\/charts\/([a-fA-F0-9]{64})$/))){const c=charts.get(match[1].toLowerCase());if(!c)return send(res,404,{error:'Unsupported chart'});return send(res,200,{chartHash:c.chartHash,webBeatmapHash:c.webBeatmapHash,device:c.device,durationSeconds:Math.ceil((c.maxEnd+136500)/1000000),provingBufferSeconds:cfg.provingBufferSeconds||0,chainId:manifest.chainId,leaderboard:board,captureMode:cfg.captureMode,...await readiness(c)});}
 if(req.method==='GET'&&(match=pathname.match(/^\/jobs\/([a-f0-9-]+)$/))){const job=jobs.get(match[1]);if(job)await reconcileJob(job);return send(res,job?200:404,job||{error:'Unknown job'});}
 if(req.method==='POST'&&(match=pathname.match(/^\/sessions\/(0x[a-fA-F0-9]{64})\/(start|proof)$/))){const id=match[1],data=await body(req);
  if(match[2]==='start'){const c=charts.get(data.webBeatmapHash);if(!c||!eq(c.chartHash,data.chartHash)||data.captureMode!==cfg.captureMode)throw Error('Chart/capture mismatch');const health=await readiness(c);if(!health.ready)throw Error(health.reason);const session=await bound(id,data);if(!eq(session.header.device,c.device))throw Error('Paid device mismatch');
   if(cfg.captureMode==='hardware')await adapter(`/sessions/${id}/start`,{header:session.header,chart:c.chart});starts.set(id,{...starts.get(id),...data,sessionId:id});saveJobs();return send(res,200,{sessionId:id,captureMode:cfg.captureMode});}
  const start=starts.get(id);if(!start||start.webBeatmapHash!==data.webBeatmapHash)throw Error('Start session first');if(start.jobId){
   const previousId=start.jobId,previous=jobs.get(previousId);
   if(!(data.retry===true&&previous?.status==='failed'&&!previous.transactionHash))return send(res,200,{jobId:start.jobId});
   await bound(id,start);
   // Another request may have created the retry while the chain read was pending.
   if(start.jobId!==previousId)return send(res,200,{jobId:start.jobId});
   delete start.jobId;
  }if(busy)return send(res,503,{error:'Prover busy; retry shortly'});
  if(cfg.captureMode==='software-demo')replayEvents(data,charts.get(start.webBeatmapHash));const jobId=randomUUID();start.jobId=jobId;const job={status:'queued',sessionId:id};jobs.set(jobId,job);saveJobs();void submit(job,start,data);return send(res,202,{jobId});
 }
 send(res,404,{error:'Not found'});
 }catch(e){send(res,400,{error:e.shortMessage||e.message});}
});
server.listen(access.port,access.host,()=>console.log(`Leaderboard bridge listening; ${cfg.captureMode}; chain ${manifest.chainId}`));
