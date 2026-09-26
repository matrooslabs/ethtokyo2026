import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {parseOsu} from './chart.mjs';import {clients,root,repoPath,readJSON,save} from './common.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node register-chart.mjs path/to/map.osu');
const parsed=parseOsu(await fs.readFile(repoPath(file)));const dir=await fs.mkdtemp(path.join(os.tmpdir(),'register-chart-'));
try{const input=readJSON(path.join(root,'scoring/fixtures/demo.json'));input.chart=parsed.chart;const tmp=path.join(dir,'play.json');await fs.writeFile(tmp,JSON.stringify(input));
const {stdout}=await promisify(execFile)(repoPath(process.env.PROVER_BINARY||'scoring/target/release/mania-gkr'),['register-chart','--srs',repoPath(process.env.SRS_FILE||'scoring/gkr-scoring/artifacts/dev-srs-22.bin'),'--input',tmp],{timeout:600000,maxBuffer:32*1024*1024});const chart=JSON.parse(stdout);
const {id,publicClient:pc,wallet,account}=clients();if(await pc.getChainId()!==id)throw Error('RPC chain mismatch');const manifest=readJSON(repoPath(process.env.DEPLOYMENT_FILE||`leaderboard/ops/deployments/${id}.mode-b.manifest.json`));if(manifest.chainId!==id)throw Error('Manifest chain mismatch');
const address=manifest.contracts.ManiaGkrRegistry,abi=manifest.abi.ManiaGkrRegistry;
const current=await pc.readContract({address,abi,functionName:'getChart',args:[chart.chartHash]});
if(!current.registered){const args=[chart.bytes,chart.commitment.map(BigInt),chart.proof.map(BigInt)];const gas=await pc.estimateContractGas({address,abi,functionName:'registerChart',args,account});if(gas*12n/10n>16777216n)throw Error('Chart registration exceeds gas cap');const hash=await wallet.writeContract({address,abi,functionName:'registerChart',args,gas:gas*12n/10n});const receipt=await pc.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('Registration reverted');console.log(`Registered ${chart.chartHash}: ${hash}`);}
save(repoPath(process.env.CHART_OUTPUT||`${parsed.webBeatmapHash}.chart.json`),{...parsed,chartHash:chart.chartHash,osuFile:repoPath(file),registration:chart});
}finally{await fs.rm(dir,{recursive:true,force:true});}
