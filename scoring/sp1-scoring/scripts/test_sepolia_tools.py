import copy
import json
from pathlib import Path
import unittest
from receipt_value import SESSION_OPENED, value_from_receipts
from session_input import bind_synthetic

ROOT = Path(__file__).resolve().parents[1]


class SepoliaToolsTests(unittest.TestCase):
    def setUp(self):
        self.play = json.loads((ROOT / "fixtures/perfect.json").read_text())
        self.session = {key: "0x" + bytes(value).hex() for key, value in self.play["header"].items() if key != "chain_id"}
        self.session.update(chain_id=11155111, consumed=False)
        self.session["session_id"] = "0x" + "99" * 32

    def test_bind_confirmed_session_and_recompute_root(self):
        previous_root = self.play["footer"]["trace_root"]
        result = bind_synthetic(self.play, self.session)
        self.assertEqual(result["header"]["chain_id"], 11155111)
        self.assertEqual(result["header"]["session_id"], [153] * 32)
        self.assertNotEqual(result["footer"]["trace_root"], previous_root)

    def test_reject_wrong_chart_chain_ruleset_and_consumed_session(self):
        for key, value in [("chain_id", 1), ("consumed", True), ("chart_hash", "0x" + "00" * 32),
                           ("ruleset_id", "0x" + "00" * 32), ("input_policy_hash", "0x" + "00" * 32),
                           ("device", "0x1234")]:
            session = dict(self.session)
            session[key] = value
            with self.assertRaises(ValueError):
                bind_synthetic(copy.deepcopy(self.play), session)

    def receipt(self):
        return {"status": "0x1", "blockNumber": "0x42", "blockHash": "0x" + "01" * 32}

    def test_extract_only_confirmed_deployment(self):
        receipt = self.receipt()
        receipt["contractAddress"] = "0x" + "12" * 20
        self.assertEqual(value_from_receipts({"receipts": [receipt]}, "deploy"), receipt["contractAddress"])
        self.assertEqual(value_from_receipts({"receipts": [receipt]}, "block"), "66")
        for data in [{}, {"receipts": [dict(receipt, status="0x0")]},
                     {"receipts": [dict(receipt, blockHash=None)]}, {"receipts": [receipt, receipt]}]:
            with self.assertRaises(ValueError):
                value_from_receipts(data, "deploy")

    def test_extract_session_from_expected_contract_event(self):
        address = "0x" + "12" * 20
        session_id = "0x" + "34" * 32
        receipt = self.receipt()
        receipt["logs"] = [{"address": address, "topics": [SESSION_OPENED, session_id, "0x" + "00" * 32, "0x" + "00" * 32]}]
        self.assertEqual(value_from_receipts({"receipts": [receipt]}, "session", address), session_id)
        with self.assertRaises(ValueError):
            value_from_receipts({"receipts": [receipt]}, "session", "0x" + "56" * 20)


if __name__ == "__main__":
    unittest.main()
