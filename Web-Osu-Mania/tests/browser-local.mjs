// Opt-in live browser test. Local unlocked Anvil only; no keys or public-network writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { encodeFunctionData, parseAbi } from 'viem';
const rpcUrl = process.env.BROWSER_TEST_RPC || 'http://127.0.0.1:19549';
if (!['127.0.0.1','localhost'].includes(new URL(rpcUrl).hostname)) throw Error('Local RPC only');
const manifest = JSON.parse(fs.readFileSync(new URL('../../leaderboard-ops/deployments/31337.manifest.json', import.meta.url)));
async function rpc(method, params=[]) {
  const response = await fetch(rpcUrl, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const data = await response.json(); if(data.error) throw Error(data.error.message); return data.result;
}
assert.equal(await rpc('eth_chainId'), '0x7a69');
const [account] = await rpc('eth_accounts');
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
  await page.goto(process.env.BROWSER_TEST_URL || 'http://localhost:3015', {waitUntil:'networkidle'});
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
  console.log('bridge ready and software demo acknowledged');
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
  console.log(JSON.stringify({liveLocalBrowser:true,account,result:text,indexerConfigured:false,errors}));
  await page.screenshot({path:'/tmp/daily-leaderboard-browser.png',fullPage:true});
} catch(error) {
  console.error((await page.locator('body').innerText()).slice(0,12000));console.error(errors);
  await page.screenshot({path:'/tmp/daily-leaderboard-browser-failed.png',fullPage:true});throw error;
} finally { clearInterval(mining);await browser.close(); }
