"""Generate input.json for a verifier template produced by
rust/src/circom_codegen.rs::gkr_verifier_template (signals inputValues, rounds<i>, q<i>).

Upstream emitted D, z, r, sumcheckr, add/mult and inputFunc as circom inputs; the fixed
verifier recomputes or hard-codes all of those, so only the prover messages and the
input-layer values are inputs now.
"""
import json


def generate_json(proof, input_values, file_path="./input.json"):
    data = {"inputValues": [str(int(v)) for v in input_values]}
    for i, rounds in enumerate(proof.sumcheck_proofs):
        data["rounds%d" % i] = [[str(int(c)) for c in g] for g in rounds]
    for i, q in enumerate(proof.q):
        data["q%d" % i] = [str(int(c)) for c in q]
    with open(file_path, "w") as out:
        json.dump(data, out, sort_keys=True, indent=4)
