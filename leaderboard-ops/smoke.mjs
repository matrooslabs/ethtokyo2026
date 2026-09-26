// Real GKR proofs and real token transfers. Hardware is explicitly software-simulated.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, decodeEventLog, parseAbi, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifact, clients, root, repoPath, readJSON, save } from './common.mjs';
import { prove } from '../leaderboard-bridge/proof.mjs';
const {id,account,publicClient:pc,wallet}=clients();
assert.equal(await pc.getChainId(),id,'RPC chain mismatch');
const deployment=readJSON(repoPath(process.env.DEPLOYMENT_FILE||`leaderboard-ops/deployments/${id}.json`));
assert.equal(deployment.chainId,id);assert.equal(deployment.ready,true);
const file=repoPath(process.env.SMOKE_FILE||`leaderboard-ops/deployments/${id}.smoke.json`);
const board=deployment.contracts.DailyLeaderboard,registry=deployment.contracts.ManiaGkrRegistry;
const boardAbi=artifact('DailyLeaderboard').abi,regAbi=artifact('ManiaGkrRegistry').abi;
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function mint(address,uint256)']);
const fee=1000000n;
function savedKey(name){const p=path.join(path.dirname(file),`${id}.${name}.key`);if(!fs.existsSync(p)){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,generatePrivateKey(),{mode:0o600,flag:'wx'});}return privateKeyToAccount(fs.readFileSync(p,'utf8').trim());}
const device=savedKey('software-device'),playerB=savedKey('player-b');
const bitstream=keccak256(toHex('DAILY_LEADERBOARD_SOFTWARE_SMOKE_V1'));
const read=(address,abi,functionName,args=[])=>pc.readContract({address,abi,functionName,args});
async function expectRevert(address,abi,functionName,args,reason){
 try{await pc.simulateContract({account,address,abi,functionName,args});}
 catch(error){let cause=error;while(cause){if(cause.name==='ContractFunctionRevertedError' && cause.message.includes(reason))return;cause=cause.cause;}throw error;}
 throw Error(`Expected ${functionName} to revert: ${reason}`);
}
const now=await pc.getBlock();
const state=fs.existsSync(file)?readJSON(file):{chainId:id,board,payer:account.address,device:device.address,playerB:playerB.address,dayId:(now.timestamp/86400n).toString(),simulation:'Software device signs synthetic fixture inputs; not physical hardware',transactions:{},sessions:{},startedUtc:new Date().toISOString()};
assert.equal(state.chainId,id);assert.equal(state.board.toLowerCase(),board.toLowerCase());assert.equal(state.payer.toLowerCase(),account.address.toLowerCase());assert.equal(state.device,device.address);assert.equal(state.playerB,playerB.address);
save(file,state);
async function send(label,address,abi,functionName,args=[]){
 const data=encodeFunctionData({abi,functionName,args});let step=state.transactions[label];
 const dataHash=keccak256(data);
 if(step){assert.equal(step.dataHash,dataHash);assert.equal(step.to,address);}
 if(!step){
  const gas=(await pc.estimateGas({account:account.address,to:address,data}))*12n/10n;assert(gas<=16777216n,'transaction gas cap');
  const nonce=await pc.getTransactionCount({address:account.address,blockTag:'pending'});
  const req=await wallet.prepareTransactionRequest({account,to:address,data,gas,nonce,...await pc.estimateFeesPerGas()});
  const serialized=await wallet.signTransaction(req);step=state.transactions[label]={hash:keccak256(serialized),serialized,dataHash,to:address};save(file,state);
 }
 let receipt=await pc.getTransactionReceipt({hash:step.hash}).catch(()=>null);
 if(!receipt){await pc.sendRawTransaction({serializedTransaction:step.serialized}).catch(async e=>{if(!await pc.getTransaction({hash:step.hash}).catch(()=>null))throw e;});receipt=await pc.waitForTransactionReceipt({hash:step.hash,confirmations:id===31337?1:2});}
 assert.equal(receipt.status,'success',`${label} reverted`);
 const canonical=await pc.getBlock({blockNumber:receipt.blockNumber});assert.equal(canonical.hash,receipt.blockHash);
 step.gasUsed=receipt.gasUsed.toString();step.blockNumber=receipt.blockNumber.toString();save(file,state);
 console.log(`${label}: ${step.hash} (${step.gasUsed} gas)`);return receipt;
}
const fixtures=path.join(root,'scoring/gkr-scoring/artifacts/forge');
const chart=readJSON(path.join(fixtures,'case-demo-a.json')).chart;
const noScore=readJSON(path.join(fixtures,'case-random0-a.json')).chart;
const day=BigInt(state.dayId),deadline=(day+1n)*86400n;
if(process.env.SMOKE_SETTLE_ONLY!=='1'){
 assert((await pc.getBlock()).timestamp<deadline,'Round closed; rerun SMOKE_SETTLE_ONLY=1 to settle this journal');
 if(id===31337&&!state.transactions.mint)await send('mint',deployment.token,tokenAbi,'mint',[account.address,10n*fee]);
 for(const [label,c] of [['chart',chart],['refund-chart',noScore]]){
  if(!(await read(registry,regAbi,'getChart',[c.chartHash])).registered)await send(label,registry,regAbi,'registerChart',[c.bytes,c.commitment.map(BigInt),c.proof.map(BigInt)]);
 }
 const registered=await read(registry,regAbi,'devices',[device.address]);
 if(!registered[1])await send('device',registry,regAbi,'setDevice',[device.address,bitstream,true]);
 else assert.equal(registered[0],bitstream);
 if(await read(deployment.token,tokenAbi,'allowance',[account.address,board])<5n*fee)await send('approve',deployment.token,tokenAbi,'approve',[board,5n*fee]);
 for(const [label,player,c] of [['low',account.address,chart],['high',account.address,chart],['tie',playerB.address,chart],['late',account.address,chart],['refund',account.address,noScore]]){
  if(!state.sessions[label]){
   const receipt=await send(`enter:${label}`,board,boardAbi,'enter',[c.chartHash,player,device.address,day]);
   const event=receipt.logs.filter(l=>l.address.toLowerCase()===board.toLowerCase()).map(l=>{try{return decodeEventLog({abi:boardAbi,data:l.data,topics:l.topics});}catch{return null;}}).find(e=>e?.eventName==='EntryPaid');
   assert(event,'EntryPaid absent');assert.equal(event.args.player.toLowerCase(),player.toLowerCase());assert.equal(event.args.dayId,day);
   state.sessions[label]=event.args.sessionId;save(file,state);
  }
 }
 for(const label of ['low','high','tie']){
  const session=await read(registry,regAbi,'getSession',[state.sessions[label]]);
  if(!session.consumed){
   const input=readJSON(path.join(root,'scoring/fixtures',label==='low'?'demo.json':'perfect.json'));
   const started=performance.now();
   const output=await prove({binary:path.join(root,'scoring/gkr-scoring/target/release/mania-gkr'),srs:path.join(root,'scoring/gkr-scoring/artifacts/dev-srs-22.bin'),input,header:session.header});
   state.provingMs??={};state.provingMs[label]=performance.now()-started;save(file,state);
   const signature=await device.sign({hash:output.digest});
   await send(`score:${label}`,registry,regAbi,'submitCalldata',[state.sessions[label],output.events,output.sub,output.proof,signature]);
   await expectRevert(registry,regAbi,'submitCalldata',[state.sessions[label],output.events,output.sub,output.proof,signature],'unknown or consumed session');
  }
  const record=await read(board,boardAbi,'entries',[state.sessions[label]]);assert.equal(record[4],true);
 }
 const round=await read(board,boardAbi,'rounds',[chart.chartHash,day]);assert.equal(round[0],4n*fee);assert.equal(round[2].toLowerCase(),account.address.toLowerCase());assert.equal(round[3],1000000);
 const b=await read(board,boardAbi,'records',[chart.chartHash,day,playerB.address]);assert.equal(b[0],true);assert.equal(b[1],1000000);
 state.verifiedPaidProofAndTie=true;save(file,state);
 await expectRevert(board,boardAbi,'claim',[chart.chartHash,day],'round open');
}
if(id===31337&&(await pc.getBlock()).timestamp<deadline){await pc.request({method:'evm_setNextBlockTimestamp',params:[Number(deadline)]});await pc.request({method:'evm_mine',params:[]});}
if((await pc.getBlock()).timestamp>=deadline){
 assert(state.verifiedPaidProofAndTie,'Incomplete proof flow; do not assert successful smoke');
 const before=await read(deployment.token,tokenAbi,'balanceOf',[account.address]);
 const round=await read(board,boardAbi,'rounds',[chart.chartHash,day]);
 let expected=0n;
 if(!round[4]){await send('claim',board,boardAbi,'claim',[chart.chartHash,day]);expected+=4n*fee;}
 if(await read(board,boardAbi,'refundablePayments',[noScore.chartHash,day,account.address])>0n){await send('refund',board,boardAbi,'refund',[noScore.chartHash,day]);expected+=fee;}
 assert.equal(await read(deployment.token,tokenAbi,'balanceOf',[account.address]),before+expected);
 const closed=await read(board,boardAbi,'rounds',[chart.chartHash,day]);assert.equal(closed[4],true);
 const refund=await read(board,boardAbi,'rounds',[noScore.chartHash,day]);assert.equal(refund[1],fee);
 await expectRevert(board,boardAbi,'claim',[chart.chartHash,day],'no claimable prize');
 await expectRevert(board,boardAbi,'refund',[noScore.chartHash,day],'nothing to refund');
 const late=await read(registry,regAbi,'getSession',[state.sessions.late]);
 const lateProof=await prove({binary:path.join(root,'scoring/gkr-scoring/target/release/mania-gkr'),srs:path.join(root,'scoring/gkr-scoring/artifacts/dev-srs-22.bin'),input:readJSON(path.join(root,'scoring/fixtures/perfect.json')),header:late.header});
 const lateSignature=await device.sign({hash:lateProof.digest});
 // At midnight the strict paid cutoff rejects an otherwise valid proof.
 await expectRevert(registry,regAbi,'submitCalldata',[state.sessions.late,lateProof.events,lateProof.sub,lateProof.proof,lateSignature],(await pc.getBlock()).timestamp===deadline?'paid round closed':'session expired');
 state.settlementVerified=true;
}else{state.settlementVerified=false;state.claimableAtUtc=new Date(Number(deadline)*1000).toISOString();}
state.checkedUtc=new Date().toISOString();save(file,state);
const publicReport={...state,transactions:Object.fromEntries(Object.entries(state.transactions).map(([k,{serialized,...v}])=>[k,v]))};
save(file.replace(/\.json$/,'.manifest.json'),publicReport);
console.log(JSON.stringify({verifiedPaidProofAndTie:state.verifiedPaidProofAndTie,settlementVerified:state.settlementVerified,claimableAtUtc:state.claimableAtUtc??null}));
