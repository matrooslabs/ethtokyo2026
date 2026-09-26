#!/usr/bin/env python3
"""Integration checks for sealed-device input validation; needs prepared 4-note fixture/SRS."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
BIN=ROOT.parent/'target/release/examples/fpga_e2e'
SRS=ROOT/'artifacts/dev-srs-22.bin'
TEMPLATE=ROOT/'artifacts/fpga-e2e-prepared/4/template.json'

def write(path,value):
    path.write_text(json.dumps(value))

class SealedAdapter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='gkr-adapter-tests-')
        cls.root=Path(cls.tmp.name)
        cls.input=json.loads(TEMPLATE.read_text())
        cls.header=copy.deepcopy(cls.input['header'])
        cls.header['input_policy_hash']=list(hashlib.sha256(b'OSUMANIA_INPUT_POLICY_V2_KZG').digest())
        write(cls.root/'header.json',cls.header)
        cls.good=cls.root/'good'; cls.good.mkdir()
        cls.capture(TEMPLATE,cls.good,True)
        cls.prove(cls.good,True)

    @classmethod
    def tearDownClass(cls): cls.tmp.cleanup()

    @classmethod
    def execute(cls,args,success):
        p=subprocess.run([str(BIN),*map(str,args),'--srs',str(SRS)],capture_output=True,text=True)
        if success and p.returncode: raise AssertionError(p.stderr)
        if not success and not p.returncode: raise AssertionError('bad input unexpectedly accepted')
        return p.stderr

    @classmethod
    def capture(cls,source,out,success):
        return cls.execute(['capture','--input',source,'--header',cls.root/'header.json','--out',out],success)

    @classmethod
    def prove(cls,out,success): return cls.execute(['prove','--out',out],success)

    def seal_mutation(self,field,value,reason):
        out=self.root/self._testMethodName; shutil.copytree(self.good,out)
        seal=json.loads((out/'device-result.json').read_text()); seal[field]=value
        write(out/'device-result.json',seal)
        self.assertIn(reason,self.prove(out,False))

    def test_honest_score_and_original_digest(self):
        proof=json.loads((self.good/'proof.json').read_text())
        seal=json.loads((self.good/'device-result.json').read_text())
        self.assertEqual(proof['result']['score'],1_000_000)
        self.assertEqual(proof['sessionDigest'],seal['sessionDigest'])
        self.assertEqual(proof['traceCommitment'],seal['traceCommitment'])

    def test_root_cannot_be_resealed(self): self.seal_mutation('root','0x'+'00'*32,'root mismatch')
    def test_commitment_cannot_be_replaced(self): self.seal_mutation('traceCommitment',['0x'+'00'*32]*2,'device commitment mismatch')
    def test_digest_cannot_be_replaced(self): self.seal_mutation('sessionDigest','0x'+'00'*32,'digest mismatch')
    def test_srs_must_match(self): self.seal_mutation('srsId','0x'+'00'*32,'SRS mismatch')
    def test_count_must_match(self): self.seal_mutation('n',0,'event count mismatch')
    def test_duration_must_match(self): self.seal_mutation('duration',0,'duration mismatch')

    def test_header_cannot_be_rebound(self):
        out=self.root/self._testMethodName; shutil.copytree(self.good,out)
        play=json.loads((out/'play.json').read_text()); play['header']['session_id'][0]^=1
        write(out/'play.json',play)
        self.assertIn('header changed after seal',self.prove(out,False))

    def bad_edge(self,transform,reason):
        out=self.root/self._testMethodName; out.mkdir()
        play=copy.deepcopy(self.input); transform(play['events'])
        source=out/'edges.json'; write(source,play)
        self.assertIn(reason,self.capture(source,out,False))
        self.assertFalse((out/'device-result.json').exists())

    def test_initial_up_rejected(self):
        self.bad_edge(lambda es:es[0].update(action=1),'invalid held transition')
    def test_duplicate_down_rejected(self):
        self.bad_edge(lambda es:es.insert(1,copy.deepcopy(es[0])),'invalid held transition')
    def test_decreasing_clock_rejected(self):
        self.bad_edge(lambda es:es[1].update(timestamp_us=0),'clock decreased')

if __name__=='__main__': unittest.main()
