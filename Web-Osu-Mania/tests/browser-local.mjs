// Opt-in live browser test. Local unlocked Anvil only; no keys or public-network writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPublicClient, http, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
const rpcUrl = process.env.BROWSER_TEST_RPC || 'http://127.0.0.1:19549';
if (!['127.0.0.1','localhost'].includes(new URL(rpcUrl).hostname)) throw Error('Local RPC only');
const manifest = JSON.parse(fs.readFileSync(process.env.BROWSER_TEST_MANIFEST || new URL('../../leaderboard/ops/deployments/31337.manifest.json', import.meta.url)));
assert.equal(manifest.chainId,31337,'Only a local deployment manifest is permitted');
const baseUrl=process.env.BROWSER_TEST_URL || 'http://localhost:3015';
const settlement=process.env.BROWSER_TEST_SETTLEMENT==='1';
const indexerUrl=process.env.BROWSER_TEST_INDEXER || 'http://127.0.0.1:19561';
let indexerMode='delayed';
const client=createPublicClient({transport:http(rpcUrl)});
const readBoard=(functionName,args)=>client.readContract({address:manifest.contracts.DailyLeaderboard,abi:manifest.abi.DailyLeaderboard,functionName,args});
const balanceOf=address=>client.readContract({address:manifest.token,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[address]});
const utcDay=day=>new Date(day*86400000).toISOString().slice(0,10);
async function rpc(method, params=[]) {
  const response = await fetch(rpcUrl, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const data = await response.json(); if(data.error) throw Error(data.error.message); return data.result;
}
assert.equal(await rpc('eth_chainId'), '0x7a69');
const [account] = await rpc('eth_accounts');
if(settlement){
  const block=await client.getBlock();
  const freshDay=(Number(block.timestamp)/86400|0)+1;
  await rpc('evm_setNextBlockTimestamp',[freshDay*86400+3600]);await rpc('evm_mine');
}
await rpc('eth_sendTransaction', [{from:account,to:manifest.token,data:encodeFunctionData({abi:parseAbi(['function mint(address,uint256)']),functionName:'mint',args:[account,5_000_000n]})}]);
const mining = setInterval(() => { void rpc('evm_mine').catch(()=>{}); }, 1000);
const browser = await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {}),args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];
page.on('pageerror',error=>{errors.push(error.message);console.error('browser runtime error:',error.message);});
try {
  await page.addInitScript(({rpcUrl,account})=>{
    const listeners=new Map();
    window.ethereum={isMetaMask:true,isConnected:()=>true,
      on:(event,fn)=>{listeners.set(event,[...(listeners.get(event)||[]),fn]);},
      removeListener:(event,fn)=>{listeners.set(event,(listeners.get(event)||[]).filter(item=>item!==fn));},
      request:async({method,params=[]})=>{
        if(['eth_accounts','eth_requestAccounts'].includes(method)) return [account];
        if(method==='wallet_switchEthereumChain') { if(params[0].chainId!=='0x7a69')throw Error('Test wallet only supports local Anvil');return null; }
        const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
        const result=await response.json();if(result.error)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.result;
      },
    };
  }, {rpcUrl,account});
  if(settlement){
    // Deliberately stale read-model fixture; all transactions/records use real local contracts.
    // Once offline, actual network requests go to an unused local port and fail normally.
    await page.route(`${indexerUrl}/**`,async route=>{
      if(indexerMode==='offline')return route.continue();
      const isStatus=new URL(route.request().url()).pathname==='/status';
      await route.fulfill({contentType:'application/json',body:JSON.stringify(isStatus
        ? {chainId:'31337',address:manifest.contracts.DailyLeaderboard,indexedBlock:'1',lag:'777',lastError:null}
        : {items:[],total:0,limit:20,offset:0,nextOffset:null,indexedBlock:'1'})});
    });
  }
  await page.goto(baseUrl, {waitUntil:'networkidle'});
  const connect = page.getByRole('button',{name:'Connect wallet',exact:true});
  if (await connect.isVisible()) {
    await connect.click();
    await page.getByRole('button',{name:/Browser Wallet|Injected/i}).first().click();
    await page.getByRole('dialog',{name:'Connect a Wallet'}).waitFor({state:'hidden'});
  }
  console.log('test wallet connected');
  await page.getByRole('button',{name:/Daily competition demo/}).click();
  await page.getByText('Daily prize · Foundry').waitFor({timeout:30000});
  await page.getByRole('checkbox').filter({visible:true}).last().check();
  console.log('scoring server ready and software demo acknowledged');
  if(settlement){
    await page.getByText('Rankings (top 20)',{exact:true}).click();
    await page.getByText(/lag 777 blocks/).waitFor();
    console.log('delayed indexer clearly labeled; real chain entry remains available');
  }
  await page.getByRole('button',{name:'Enter daily competition · 1 USDC'}).click();
  await page.locator('#game canvas').waitFor({timeout:60000});
  console.log('entry confirmed; live game canvas ready');
  await page.waitForTimeout(1000);
  await page.keyboard.press('d',{delay:100});
  await page.getByRole('heading',{name:'Daily competition proof'}).waitFor({timeout:90000});
  console.log('actual gameplay completed; submitting recorded replay');
  fs.writeFileSync('/tmp/browser-paid-proof.json', JSON.stringify(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('paid-proof:')||key.startsWith('paid-entry:')))),null,2));
  await page.getByRole('button',{name:'Submit / recheck proof'}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('Verified score accepted on-chain:') || document.body.innerText.includes('This job failed.') || [...document.querySelectorAll('button')].some(button=>button.textContent==='Retry proof'),null,{timeout:120000});
  assert.equal(await page.getByText(/Verified score accepted on-chain:/).isVisible(),true,'Actual browser replay must be accepted on-chain');
  const text=await page.getByText(/Verified score accepted on-chain:/).textContent();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({liveLocalBrowser:true,account,result:text,indexerConfigured:settlement,errors}));
  await page.screenshot({path:'/tmp/daily-leaderboard-browser.png',fullPage:true});
  if(settlement){
    const latestAttempt=()=>page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('paid-entry:')).map(([,value])=>JSON.parse(value)).sort((a,b)=>b.dayId-a.dayId)[0]);
    const scored=await latestAttempt();
    const firstRound=await readBoard('rounds',[scored.chartHash,BigInt(scored.dayId)]);
    assert.equal(firstRound[2].toLowerCase(),account.toLowerCase());
    assert.equal(firstRound[3],0,'Zero accepted score must still establish a winner');
    assert.equal((await readBoard('entries',[scored.sessionId]))[4],true);
    assert.equal(firstRound[4],false);
    const openRound=async day=>{
      await page.goto(baseUrl,{waitUntil:'networkidle'});
      await page.getByRole('button',{name:/Daily competition demo/}).click();
      await page.getByText('Daily prize · Foundry',{exact:true}).waitFor();
      if(day!==undefined)await page.getByLabel('Competition UTC date').fill(utcDay(day));
    };
    const offlineRankings=async()=>{
      await page.getByText('Rankings (top 20)',{exact:true}).click();
      await page.getByText('Rankings unavailable. Pot, personal best, claims and refunds use the contract directly.',{exact:true}).waitFor();
    };
    const rollover=async day=>{
      await rpc('evm_setNextBlockTimestamp',[(day+1)*86400]);await rpc('evm_mine');
      assert(Number((await client.getBlock()).timestamp)>=(day+1)*86400);
    };
    // UTC day A -> B: click the actual claim button with the indexer offline.
    indexerMode='offline';await rollover(scored.dayId);await openRound(scored.dayId);
    await offlineRankings();
    const beforeClaim=await balanceOf(account);
    await page.getByRole('button',{name:'Send prize to winner',exact:true}).click();
    await page.getByText('Prize sent to the winning wallet.',{exact:true}).waitFor({timeout:60000});
    await page.getByRole('button',{name:'Send prize to winner',exact:true}).waitFor({state:'hidden'});
    const claimed=await readBoard('rounds',[scored.chartHash,BigInt(scored.dayId)]);
    assert.equal(claimed[4],true);assert.equal(await balanceOf(account),beforeClaim+firstRound[0]);
    await page.screenshot({path:'/tmp/daily-leaderboard-browser-claim.png',fullPage:true});
    console.log('browser claim passed after UTC rollover while indexer offline');
    // Day B: complete another paid game, but deliberately do not submit its proof.
    await openRound();
    await page.getByRole('checkbox').filter({visible:true}).last().check();
    await page.getByRole('button',{name:'Enter daily competition · 1 USDC',exact:true}).click();
    await page.locator('#game canvas').waitFor({timeout:60000});await page.waitForTimeout(1000);
    await page.keyboard.press('d',{delay:100});
    await page.getByRole('heading',{name:'Daily competition proof'}).waitFor({timeout:90000});
    const unscored=await latestAttempt();assert.equal(unscored.dayId,scored.dayId+1);
    assert.equal((await readBoard('entries',[unscored.sessionId]))[4],false);
    await page.getByRole('button',{name:'Back',exact:true}).click();
    // UTC day B -> C: the no-score round refunds the payer through the UI.
    await rollover(unscored.dayId);await openRound(unscored.dayId);await offlineRankings();
    const beforeRefund=await balanceOf(account);
    const noScore=await readBoard('rounds',[unscored.chartHash,BigInt(unscored.dayId)]);
    assert.equal(noScore[2],zeroAddress,'Unsubmitted gameplay is not an accepted zero score');
    await page.getByRole('button',{name:'Refund 1 USDC',exact:true}).click();
    await page.getByText('Entry fees refunded to your wallet.',{exact:true}).waitFor({timeout:60000});
    await page.getByRole('button',{name:'Refund 1 USDC',exact:true}).waitFor({state:'hidden'});
    const refunded=await readBoard('rounds',[unscored.chartHash,BigInt(unscored.dayId)]);
    assert.equal(refunded[1],1000000n);assert.equal(refunded[4],false);
    assert.equal(await balanceOf(account),beforeRefund+1000000n);
    assert.equal(await readBoard('refundablePayments',[unscored.chartHash,BigInt(unscored.dayId),account]),0n);
    assert.deepEqual(errors,[]);
    const claimEvents=await client.getContractEvents({address:manifest.contracts.DailyLeaderboard,abi:manifest.abi.DailyLeaderboard,eventName:'PrizeClaimed',args:{beatmapId:scored.chartHash,dayId:BigInt(scored.dayId)},fromBlock:BigInt(manifest.deploymentBlock)});
    const refundEvents=await client.getContractEvents({address:manifest.contracts.DailyLeaderboard,abi:manifest.abi.DailyLeaderboard,eventName:'EntryRefunded',args:{beatmapId:unscored.chartHash,dayId:BigInt(unscored.dayId)},fromBlock:BigInt(manifest.deploymentBlock)});
    const evidence={browserSettlement:true,chainId:31337,scoredSession:scored.sessionId,unscoredSession:unscored.sessionId,scoredDay:scored.dayId,refundDay:unscored.dayId,claimTransaction:claimEvents.at(-1)?.transactionHash,refundTransaction:refundEvents.at(-1)?.transactionHash,prizeAmount:firstRound[0].toString(),refundAmount:refunded[1].toString(),delayedIndexerLabel:true,offlineIndexerSettlement:true,errors};
    fs.writeFileSync('/tmp/browser-settlement-evidence.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
    await page.screenshot({path:'/tmp/daily-leaderboard-browser-refund.png',fullPage:true});
  }
} catch(error) {
  console.error((await page.locator('body').innerText()).slice(0,12000));console.error(errors);
  await page.screenshot({path:'/tmp/daily-leaderboard-browser-failed.png',fullPage:true});throw error;
} finally { clearInterval(mining);await browser.close(); }
