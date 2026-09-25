#!/usr/bin/env python3
"""Read-only, post-run canonical receipt and registry state verification."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from sepolia_e2e import ROOT, config, number, words, write

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('run_directory',type=Path)
    p.add_argument('--env-file',default=str(ROOT.parent/'sp1-scoring/.env'))
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    run=json.loads((args.run_directory/'run.json').read_text())
    assert run['status']=='complete' and run['chainId']==11155111
    rpc_url=config(args.env_file)['SEPOLIA_RPC_URL']
    env=dict(os.environ,ETH_RPC_URL=rpc_url,ETH_RPC_TIMEOUT='30',NO_COLOR='1')
    def cast(command,input=None):
        r=subprocess.run(['cast',*command],input=input,capture_output=True,text=True,env=env,timeout=45)
        if r.returncode: raise RuntimeError(r.stderr.replace(rpc_url,'[RPC]')[:500])
        return r.stdout.strip()
    def rpc(method,params): return json.loads(cast(['rpc','--raw',method],json.dumps(params)))
    assert int(rpc('eth_chainId',[]),16)==11155111
    latest=rpc('eth_getBlockByNumber',['latest',False])
    finalized=rpc('eth_getBlockByNumber',['finalized',False])
    head=int(latest['number'],16)
    def check_tx(tx):
        receipt=rpc('eth_getTransactionReceipt',[tx['hash']])
        assert receipt and int(receipt['status'],16)==1
        assert receipt['blockHash']==tx['receipt']['blockHash']
        canonical=rpc('eth_getBlockByNumber',[receipt['blockNumber'],False])
        assert canonical['hash']==receipt['blockHash']
        confirmations=head-int(receipt['blockNumber'],16)+1
        assert confirmations>=run['confirmationsRequired']
        return {'hash':tx['hash'],'label':tx['label'],'block':int(receipt['blockNumber'],16),
            'blockHash':receipt['blockHash'],'status':1,'confirmationsAtSnapshot':confirmations,
            'finalizedAtSnapshot':int(receipt['blockNumber'],16)<=int(finalized['number'],16)}
    with ThreadPoolExecutor(max_workers=4) as pool: transactions=list(pool.map(check_tx,run['transactions']))
    registry=run['contracts']['ManiaGkrRegistry']
    def check_session(row):
        data=cast(['calldata','getSession(bytes32)',row['sessionId']])
        state=words(rpc('eth_call',[{'to':registry,'data':data},latest['number']]))
        assert number(state[0])==11155111 and state[1][-20:].hex()==registry[2:].lower()
        assert number(state[11])==2 and number(state[13])==1 and number(state[14])==row['score']
        assert [number(w) for w in state[15:21]]==row['judgements']
        return {'sessionId':row['sessionId'],'mode':2,'consumed':True,'score':number(state[14]),
            'judgements':[number(w) for w in state[15:21]],'notes':row['notes'],'rep':row['rep']}
    with ThreadPoolExecutor(max_workers=4) as pool: sessions=list(pool.map(check_session,run['runs']))
    contracts={}
    for name,address in run['contracts'].items():
        code=bytes.fromhex(rpc('eth_getCode',[address,latest['number']])[2:])
        assert code
        contracts[name]={'address':address,'runtimeBytes':len(code),'runtimeSha256':hashlib.sha256(code).hexdigest()}
    result={'checkedUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'chainId':11155111,
        'headBlock':head,'headBlockHash':latest['hash'],'finalizedBlock':int(finalized['number'],16),
        'allChecksPassed':True,'transactions':transactions,'sessions':sessions,'contracts':contracts}
    write(args.out,result)
    print('PASS',len(transactions),'canonical successful receipts;',len(sessions),'mode-B consumed scores;',
        sum(x['finalizedAtSnapshot'] for x in transactions),'transactions finalized at snapshot')

if __name__=='__main__': main()
