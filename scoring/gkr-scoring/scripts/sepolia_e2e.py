#!/usr/bin/env python3
"""Real mode-B E2E: virtual FPGA edges -> signed seal -> GKR -> mined Sepolia score.

All signing uses existing encrypted keystores. No passwords/private keys in JSON/logs.
Use --local ONLY for Anvil smoke tests; live runs require chain 11155111.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "target/release/examples/fpga_e2e"
HEADER_FIELDS = ["chain_id", "verifier", "match_id", "session_id", "challenge",
                 "player", "device", "chart_hash", "ruleset_id", "bitstream_hash", "input_policy_hash"]

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)

def load(path):
    return json.loads(Path(path).read_text())

def config(path):
    return {k.strip(): v.strip().strip("\"'") for k, v in
            (line.split("=", 1) for line in Path(path).read_text().splitlines()
             if line.strip() and not line.lstrip().startswith("#") and "=" in line)}

def array(xs):
    return "[" + ",".join(map(str, xs)) + "]"

def words(data):
    raw = bytes.fromhex(data.removeprefix("0x"))
    assert len(raw) % 32 == 0
    return [raw[i:i+32] for i in range(0, len(raw), 32)]

def number(word):
    return int.from_bytes(word, "big")

class Runner:
    def __init__(self, args):
        self.args = args
        cfg = config(args.env_file)
        self.rpc_url = args.rpc or cfg["SEPOLIA_RPC_URL"]
        self.sender = args.sender or cfg["SENDER_ADDRESS"]
        self.device = load(args.device)
        self.out = Path(args.out).resolve()
        self.out.mkdir(parents=True, exist_ok=True)
        if (self.out / "run.json").exists():
            raise RuntimeError("Output already has a run.json; use a fresh output directory")
        self.env = dict(os.environ, ETH_RPC_URL=self.rpc_url, ETH_RPC_TIMEOUT="30", NO_COLOR="1")
        self.result = {"status": "running", "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "simulation": "Virtual-time software FPGA with sequential event SHA/KZG and encrypted software device key",
            "srsSecurity": "INSECURE known-tau dev SRS; functional/performance demo only",
            "confirmationsRequired": args.confirmations, "sender": self.sender,
            "device": self.device["device"], "transactions": [], "runs": [], "contracts": {},
            "machine": {"platform": platform.platform(), "cpuCount": os.cpu_count()},
            "cases": args.cases, "reps": args.reps}

    def save(self):
        write(self.out / "run.json", self.result)

    def run(self, command, *, input=None, timeout=120, cwd=None):
        p = subprocess.run(list(map(str, command)), input=input, capture_output=True,
                           text=True, env=self.env, timeout=timeout, cwd=cwd or ROOT)
        if p.returncode:
            error = (p.stderr or p.stdout).replace(self.rpc_url, "[RPC]")
            raise RuntimeError(command[0] + " failed: " + error[:1200])
        return p.stdout.strip()

    def rpc(self, method, params):
        # stdin keeps large eth_call payloads away from the platform argv size limit.
        return json.loads(self.run(["cast", "rpc", "--raw", method], input=json.dumps(params), timeout=45))

    def calldata(self, signature, *args):
        return self.run(["cast", "calldata", signature, *map(str, args)])

    def call(self, to, data, block="latest"):
        return self.rpc("eth_call", [{"from":self.sender,"to":to,"data":data}, block])

    def wait_receipt(self, tx_hash, started):
        deadline = time.monotonic() + 240
        first = None
        while time.monotonic() < deadline:
            receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
            if receipt:
                if first is None: first = time.monotonic() - started
                assert int(receipt["status"],16) == 1, "transaction reverted: " + tx_hash
                block = int(receipt["blockNumber"],16)
                head = int(self.rpc("eth_blockNumber", []),16)
                if head - block + 1 >= self.args.confirmations:
                    canonical = self.rpc("eth_getBlockByNumber", [receipt["blockNumber"],False])
                    assert canonical["hash"] == receipt["blockHash"], "receipt reorged"
                    return receipt, first, time.monotonic()-started, head-block+1
            time.sleep(0.25 if self.args.local else 2)
        raise RuntimeError("Receipt timeout; inspect pending transaction, do not resend blindly: " + tx_hash)

    def send(self, label, to, data):
        tx = {"from":self.sender,"data":data}
        if to: tx["to"] = to
        t = time.monotonic()
        self.rpc("eth_call", [tx,"latest"])
        estimated = int(self.rpc("eth_estimateGas", [tx]),16)
        preflight = time.monotonic()-t
        gas_limit = (estimated*12+9)//10
        assert gas_limit <= 16_777_216, "transaction exceeds conservative per-tx gas cap"
        command = ["cast", "send", "--async", "--gas-limit", str(gas_limit), "--from", self.sender]
        if self.args.local:
            command += ["--unlocked"]
        else:
            command += ["--keystore",str(Path(self.args.keystore).expanduser()),"--password-file",self.args.password_file]
        command += [to,data] if to else ["--create",data]
        started = time.monotonic()
        tx_hash = self.run(command,timeout=90).strip('"')
        assert tx_hash.startswith("0x") and len(tx_hash)==66, "invalid transaction response"
        entry = {"label":label,"hash":tx_hash,"estimatedGas":estimated,"gasLimit":gas_limit,
            "calldataBytes":(len(data)-2)//2,"preflightSeconds":preflight,"broadcastResponseSeconds":time.monotonic()-started}
        self.result["transactions"].append(entry); self.save()
        print("BROADCAST",label,tx_hash,flush=True)
        receipt, first, confirmed, confirmations = self.wait_receipt(tx_hash,started)
        entry.update({"receipt":receipt,"inclusionSeconds":first,"confirmationSeconds":confirmed,
            "confirmations":confirmations,"gasUsed":int(receipt["gasUsed"],16),
            "feeWei":int(receipt["gasUsed"],16)*int(receipt["effectiveGasPrice"],16)})
        self.save()
        print("CONFIRMED",label,"gas",entry["gasUsed"],"seconds",round(confirmed,3),flush=True)
        return entry

    def deploy(self, name, ctor=""):
        artifact = load(ROOT/"contracts/out"/(name+".sol")/(name+".json"))
        code = artifact["bytecode"]["object"] + ctor.removeprefix("0x")
        tx = self.send("deploy-"+name,None,code)
        address=tx["receipt"]["contractAddress"]
        assert self.rpc("eth_getCode",[address,"latest"]) != "0x"
        self.result["contracts"][name]=address; self.save()
        return address

    def check_revert(self, label, registry, data):
        try: self.call(registry,data)
        except RuntimeError as error:
            # A network outage is NOT evidence of a rejected bad proof.
            if "revert" not in str(error).lower(): raise
            return {"check":label,"rejected":True,"reason":str(error)[:250]}
        raise AssertionError(label+" was accepted")

    def execute(self):
        chain=int(self.rpc("eth_chainId",[]),16)
        assert chain == (31337 if self.args.local else 11155111), "wrong chain"
        self.result["chainId"]=chain
        self.result["balanceBeforeWei"]=int(self.rpc("eth_getBalance",[self.sender,"latest"]),16)
        if not self.args.local:
            assert self.result["balanceBeforeWei"] > 10**17, "need at least 0.1 Sepolia test ETH for this benchmark"
            signer=self.run(["cast","wallet","address","--keystore",str(Path(self.args.keystore).expanduser()),"--password-file",self.args.password_file])
            assert signer.lower()==self.sender.lower(),"unexpected organizer signer"
        device_addr=self.run(["cast","wallet","address","--keystore",self.device["keystorePath"],"--password-file",self.device["passwordFile"]])
        assert device_addr.lower()==self.device["device"].lower()
        self.result["versions"]={cmd:self.run([cmd,"--version"]) for cmd in ["forge","cast","rustc"]}
        self.result["sourceSha256"]={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
            for path in [ROOT/"engine/examples/fpga_e2e.rs",Path(__file__).resolve(),*sorted((ROOT/"contracts/src").glob("*.sol"))]}
        self.result["srsFileSha256"]=hashlib.sha256(Path(self.args.srs).read_bytes()).hexdigest()
        self.save()
        prepared=Path(self.args.prepared).resolve(); vk=load(prepared/"vk.json")
        self.result["srsId"]=vk["srsId"]; self.result["srsSmax"]=vk["smax"]
        relation=self.deploy("GkrRelation")
        ctor=self.run(["cast","abi-encode","f(address,uint256,uint256[4],uint256[4],uint256[4][])",relation,str(vk["smax"]),array(vk["g2One"]),array(vk["g2Tau"]),array(array(x) for x in vk["g2Shift"])])
        verifier=self.deploy("GkrScoreVerifier",ctor)
        registry=self.deploy("ManiaGkrRegistry",self.run(["cast","abi-encode","f(address)",verifier]))
        assert self.call(verifier,self.calldata("srsId()"))==vk["srsId"]
        assert self.call(registry,self.calldata("organizer()"))[-40:].lower()==self.sender[2:].lower()
        self.send("register-software-device",registry,self.calldata("setDevice(address,bytes32,bool)",device_addr,self.device["bitstreamHash"],"true"))
        opened_topic=self.run(["cast","keccak","SessionOpened(bytes32,address,address,uint8)"])
        accepted_topic=self.run(["cast","keccak","ScoreAccepted(bytes32,address,uint32)"])
        match_id="0x"+hashlib.sha256(("GKR_FPGA_E2E_"+self.result["startedUtc"]).encode()).hexdigest()
        for count in self.args.cases:
            chart=load(prepared/str(count)/"chart.json")
            registration=self.send("register-chart-"+str(count),registry,self.calldata("registerChart(bytes,uint256[2],uint256[])",chart["bytes"],array(chart["commitment"]),array(chart["proof"])))
            on_chart=words(self.call(registry,self.calldata("getChart(bytes32)",chart["chartHash"])))
            assert [number(w) for w in on_chart[:2]]==[int(v,16) for v in chart["commitment"]]
            assert [number(w) for w in on_chart[2:]]==[count,chart["bits"],chart["components"],chart["maxEnd"],1]
            for rep in range(1,self.args.reps+1):
                run_dir=self.out/f"{count}-r{rep}"; run_dir.mkdir()
                e2e_start=time.monotonic()
                latest=self.rpc("eth_getBlockByNumber",["latest",False])
                expires=int(latest["timestamp"],16)+86400
                opened=self.send(f"open-{count}-r{rep}",registry,self.calldata("openSession(bytes32,bytes32,address,address,uint64,uint8)",match_id,chart["chartHash"],self.sender,device_addr,expires,2))
                logs=[x for x in opened["receipt"]["logs"] if x["address"].lower()==registry.lower() and x["topics"][0]==opened_topic]
                assert len(logs)==1
                session_id=logs[0]["topics"][1]
                session_data=words(self.call(registry,self.calldata("getSession(bytes32)",session_id)))
                assert len(session_data)==21 and number(session_data[11])==2 and number(session_data[13])==0
                header={name:(number(w) if i==0 else list(w[-20:] if i in [1,5,6] else w)) for i,(name,w) in enumerate(zip(HEADER_FIELDS,session_data))}
                assert header["chain_id"]==chain and bytes(header["verifier"]).hex()==registry[2:].lower()
                assert bytes(header["chart_hash"]).hex()==chart["chartHash"][2:]
                assert bytes(header["session_id"]).hex()==session_id[2:]
                write(run_dir/"header.json",header)
                work_start=time.monotonic()
                t=time.monotonic()
                self.run([BIN,"capture","--srs",self.args.srs,"--input",prepared/str(count)/"template.json","--header",run_dir/"header.json","--out",run_dir])
                capture_wall=time.monotonic()-t
                seal=load(run_dir/"device-result.json")
                t=time.monotonic()
                signature=self.run(["cast","wallet","sign","--no-hash","--keystore",self.device["keystorePath"],"--password-file",self.device["passwordFile"],seal["sessionDigest"]])
                sign_wall=time.monotonic()-t
                assert len(bytes.fromhex(signature[2:]))==65
                verify_output=self.run(["cast","wallet","verify","--no-hash","--address",device_addr,seal["sessionDigest"],signature])
                assert "validation succeeded" in verify_output.lower(),verify_output
                write(run_dir/"signature.json",{"signature":signature})
                t=time.monotonic(); self.run([BIN,"prove","--srs",self.args.srs,"--out",run_dir]); prove_wall=time.monotonic()-t
                proof=load(run_dir/"proof.json")
                assert proof["sessionDigest"]==seal["sessionDigest"] and proof["traceCommitment"]==seal["traceCommitment"]
                assert proof["chartCommitment"]==chart["commitment"]
                def submission(p, sig=signature):
                    sub="("+str(p["duration"])+","+array(p["laneBits"])+","+array(p["counts"])+")"
                    return self.calldata("submitCommitted(bytes32,uint32,bytes32,uint256[2],(uint64,uint8[4],uint32[5]),uint256[],bytes)",session_id,p["n"],p["root"],array(p["traceCommitment"]),sub,array(p["proof"]),sig)
                data=submission(proof)
                write(run_dir/"submission.json",{"to":registry,"data":data})
                ready_wall=time.monotonic()-work_start
                negative=[]
                if rep==1:
                    mutated=dict(proof,root="0x"+bytes([bytes.fromhex(proof["root"][2:])[0]^1]).hex()+proof["root"][4:])
                    negative.append(self.check_revert("mutated-root",registry,submission(mutated)))
                    mutated=dict(proof,proof=list(proof["proof"]))
                    mutated["proof"][5]=hex((int(mutated["proof"][5],16)+1)%21888242871839275222246405745257275088548364400416034343698204186575808495617)
                    negative.append(self.check_revert("mutated-proof",registry,submission(mutated)))
                submitted=self.send(f"submit-{count}-r{rep}",registry,data)
                stored=words(self.call(registry,self.calldata("getSession(bytes32)",session_id),submitted["receipt"]["blockNumber"]))
                assert number(stored[13])==1 and number(stored[14])==seal["expectedScore"]
                assert [number(w) for w in stored[15:21]]==seal["expectedJudgements"]
                accepted=[x for x in submitted["receipt"]["logs"] if x["address"].lower()==registry.lower() and x["topics"][0]==accepted_topic and x["topics"][1]==session_id]
                assert len(accepted)==1 and int(accepted[0]["data"],16)==seal["expectedScore"]
                if rep==1: negative.append(self.check_revert("replay",registry,data))
                row={"notes":count,"rep":rep,"events":proof["n"],"sessionId":session_id,
                    "score":number(stored[14]),"judgements":[number(w) for w in stored[15:21]],
                    "openTx":opened["hash"],"submitTx":submitted["hash"],"chartRegistrationTx":registration["hash"],
                    "captureProcessSeconds":capture_wall,"signProcessSeconds":sign_wall,"proveProcessSeconds":prove_wall,
                    "captureStartToSubmissionReadySeconds":ready_wall,"openStartToValidatedScoreSeconds":time.monotonic()-e2e_start,
                    "submitInclusionSeconds":submitted["inclusionSeconds"],"submitConfirmationSeconds":submitted["confirmationSeconds"],
                    "submitPreflightSeconds":submitted["preflightSeconds"],"gasUsed":submitted["gasUsed"],"feeWei":submitted["feeWei"],
                    "calldataBytes":submitted["calldataBytes"],"proofBytes":proof["proofBytes"],"proofWords":proof["proofWords"],
                    "deviceTimings":seal["timings"],"proverTimings":proof["timings"],"nativeVerifyMs":proof["nativeVerifyMs"],
                    "virtualPlaySeconds":seal["virtualPlaySeconds"],"negativeChecks":negative,"consumed":True}
                self.result["runs"].append(row); self.save(); print("SCORE_ACCEPTED",count,rep,row["score"],flush=True)
        self.result["balanceAfterWei"]=int(self.rpc("eth_getBalance",[self.sender,"latest"]),16)
        self.result["totalFeeWei"]=sum(x["feeWei"] for x in self.result["transactions"])
        self.result["finishedUtc"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
        self.result["status"]="complete"
        self.save()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env-file",default=str(ROOT.parent/"sp1-scoring/.env"))
    p.add_argument("--device",default=str(ROOT.parent/"sp1-scoring/artifacts/software-device.json"))
    p.add_argument("--keystore",default="~/.foundry/keystores/sepolia-deployer")
    p.add_argument("--password-file",default=str(ROOT.parent/"sp1-scoring/artifacts/private-signing/deployer.password"))
    p.add_argument("--rpc"); p.add_argument("--sender"); p.add_argument("--local",action="store_true")
    p.add_argument("--srs",default=str(ROOT/"artifacts/dev-srs-22.bin"))
    p.add_argument("--prepared",default=str(ROOT/"artifacts/fpga-e2e-prepared"))
    p.add_argument("--out",required=True); p.add_argument("--cases",default="500,1500,3000")
    p.add_argument("--reps",type=int,default=3); p.add_argument("--confirmations",type=int,default=2)
    args=p.parse_args(); args.cases=[int(x) for x in args.cases.split(',')]
    assert args.reps>0 and args.confirmations>=1
    runner=Runner(args)
    try: runner.execute()
    except BaseException as error:
        runner.result["status"]="failed"; runner.result["error"]=str(error).replace(runner.rpc_url,"[RPC]")
        runner.save(); raise

if __name__=="__main__": main()
