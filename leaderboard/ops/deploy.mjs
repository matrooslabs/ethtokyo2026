import fs from 'node:fs';
import path from 'node:path';
import { encodeDeployData, encodeFunctionData, keccak256, getContractAddress, zeroAddress } from 'viem';
import { artifact, clients, root, repoPath, readJSON, save } from './common.mjs';
const {id, account, publicClient:pc, wallet}=clients();
if(await pc.getChainId()!==id) throw Error('RPC chain mismatch');
const output=repoPath(process.env.DEPLOYMENT_FILE || path.join(root,`leaderboard/ops/deployments/${id}.json`));
const vk=readJSON(repoPath(process.env.VK_FILE || 'scoring/gkr-scoring/artifacts/forge/vk.json'));
if(process.env.ALLOW_INSECURE_DEMO_SRS!=='1') throw Error('Current generated SRS uses known tau: set ALLOW_INSECURE_DEMO_SRS=1 for test/demo only');
const journal=fs.existsSync(output)?readJSON(output):{version:1,chainId:id,deployer:account.address,srsId:vk.srsId,security:'INSECURE known-tau development SRS; demo only',transactions:{},contracts:{}};
if(journal.chainId!==id || journal.deployer.toLowerCase()!==account.address.toLowerCase() || journal.srsId!==vk.srsId) throw Error('Journal configuration mismatch');
const abis={};
async function transaction(label,data,to){
 const fingerprint=keccak256(data);
 let step=journal.transactions[label];
 if(step && (step.dataHash!==fingerprint || step.to!==to)) throw Error(`Configuration changed for ${label}; use a new journal`);
 if(!step){
  const nonce=await pc.getTransactionCount({address:account.address,blockTag:'pending'});
  const gas=await pc.estimateGas({account:account.address,data,to});
  const limit=gas*12n/10n;
  if(limit>16777216n) throw Error(`${label} exceeds 2^24 transaction gas cap: ${limit}`);
  const fees=await pc.estimateFeesPerGas();
  const request=await wallet.prepareTransactionRequest({account,data,to,nonce,gas:limit,...fees});
  const serialized=await wallet.signTransaction(request);
  // Persist signed bytes and hash BEFORE broadcast so crash recovery rebroadcasts the same nonce.
  const hash=keccak256(serialized);
  step=journal.transactions[label]={hash,serialized,nonce,dataHash:fingerprint,to}; save(output,journal);
 }
 let receipt=await pc.getTransactionReceipt({hash:step.hash}).catch(()=>null);
 if(!receipt){
  await pc.sendRawTransaction({serializedTransaction:step.serialized}).catch(async e=>{
   const tx=await pc.getTransaction({hash:step.hash}).catch(()=>null); if(!tx) throw e;
  });
  receipt=await pc.waitForTransactionReceipt({hash:step.hash});
 }
 if(receipt.status!=='success') throw Error(`${label} reverted: ${step.hash}`);
 step.blockNumber=receipt.blockNumber.toString(); step.gasUsed=receipt.gasUsed.toString();save(output,journal);
 console.log(`${label}: ${step.hash} (${receipt.gasUsed} gas)`);
 return receipt;
}
async function deploy(name,args=[],source=name){
 const a=artifact(name,source);abis[name]=a.abi;
 const data=encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args});
 const r=await transaction(`deploy:${name}`,data);
 const address=r.contractAddress || getContractAddress({from:account.address,nonce:BigInt(journal.transactions[`deploy:${name}`].nonce)});
 const code=await pc.getCode({address});if(!code || code==='0x') throw Error(`Missing code for ${name}`);
 journal.contracts[name]=address;save(output,journal);return address;
}
const relation=await deploy('GkrRelation');
const shifts=Array.from({length:vk.g2Shift.length/4},(_,i)=>vk.g2Shift.slice(i*4,i*4+4).map(BigInt));
const verifier=await deploy('GkrScoreVerifier',[relation,BigInt(vk.smax),vk.g2One.map(BigInt),vk.g2Tau.map(BigInt),shifts]);
const registry=await deploy('ManiaGkrRegistry',[verifier]);
let token=process.env.USDC_ADDRESS;
if(id===11155111){token ||= '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';if(token.toLowerCase()!=='0x1c7d4b196cb0c7b01d743fbc6116a902379c7238')throw Error('Sepolia must use canonical Circle test USDC');}
if(id===31337 && !token) token=await deploy('DemoUSDC');
const board=await deploy('DailyLeaderboard',[token,registry]);
const current=await pc.readContract({address:registry,abi:abis.ManiaGkrRegistry,functionName:'leaderboard'});
if(current===zeroAddress) await transaction('wire:leaderboard',encodeFunctionData({abi:abis.ManiaGkrRegistry,functionName:'setLeaderboard',args:[board]}),registry);
else if(current.toLowerCase()!==board.toLowerCase())throw Error('Registry already wired to another board');
for(const [name,address,fn,want] of [['DailyLeaderboard',board,'registry',registry],['DailyLeaderboard',board,'token',token],['ManiaGkrRegistry',registry,'verifier',verifier]]){
 const got=await pc.readContract({address,abi:abis[name],functionName:fn});if(got.toLowerCase()!==want.toLowerCase())throw Error(`Wiring mismatch ${fn}`);
}
for(const [name,address,fn,want] of [['GkrScoreVerifier',verifier,'srsId',vk.srsId],['ManiaGkrRegistry',registry,'organizer',account.address],['ManiaGkrRegistry',registry,'leaderboard',board]]){
 const got=await pc.readContract({address,abi:abis[name],functionName:fn});if(got.toLowerCase()!==want.toLowerCase())throw Error(`Configuration mismatch ${fn}`);
}
const fee=await pc.readContract({address:board,abi:abis.DailyLeaderboard,functionName:'ENTRY_FEE'});
if(fee!==1000000n)throw Error('Unexpected entry fee');
const decimals=await pc.readContract({address:token,abi:[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}],functionName:'decimals'});
if(decimals!==6)throw Error('Token must use six decimals');
journal.token=token;journal.entryFee='1000000';journal.deploymentBlock=journal.transactions['deploy:DailyLeaderboard'].blockNumber;
journal.abi=abis;journal.ready=true;save(output,journal);
// Public manifest omits signed transaction bytes, used only for crash recovery.
const manifest={...journal,transactions:Object.fromEntries(Object.entries(journal.transactions).map(([k,{serialized,...v}])=>[k,v]))};
save(output.replace(/\.json$/,'.manifest.json'),manifest);
console.log(`Verified deployment manifest: ${output.replace(/\.json$/,'.manifest.json')}`);
