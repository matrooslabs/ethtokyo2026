"""Security regression tests for the fixed python GKR (run: python3 -m unittest -v).

Requires `pip install ethsnarks` (field arithmetic; pysha3 for keccak).
"""
import copy
import unittest

from ethsnarks import field, mimc

import legacy_upstream
from gkr import Circuit, Proof, prove, verify, circuit_digest, mle
from poly import get_multi_ext, eval_univariate
from transcript import Transcript, DOMAIN_PROOF, mimc7

zero, one = field.FQ.zero(), field.FQ.one()
F = field.FQ


def example_circuit():
    """Upstream example (test_gkr.py): outputs (3*3 * 2*2, 2*3 * 1*1) = (36, 6)."""
    c = Circuit(3)
    for idx, v in enumerate([36, 6]):
        c.add_node(0, idx, [idx], v)
    for idx, v in enumerate([9, 4, 6, 1]):
        c.add_node(1, idx, [idx >> 1, idx & 1], v)
    for idx, v in enumerate([3, 2, 3, 1]):
        c.add_node(2, idx, [idx >> 1, idx & 1], v)

    def table(values, k):
        def f(bits):
            return F(values[int("".join(str(int(b)) for b in bits), 2)])
        return f

    def pred(gates, k_out, k_in):
        def f(bits):
            key = tuple(int(b) for b in bits)
            return one if key in gates else zero
        return f

    def gate_bits(z, b, cc, kz, kn):
        tobits = lambda v, k: tuple((v >> (k - 1 - j)) & 1 for j in range(k))
        return tobits(z, kz) + tobits(b, kn) + tobits(cc, kn)

    c.layers[0].add_func(table([36, 6], 1))
    c.layers[1].add_func(table([9, 4, 6, 1], 2))
    c.layers[2].add_func(table([3, 2, 3, 1], 2))
    c.layers[0].mult = pred({gate_bits(0, 0, 1, 1, 2), gate_bits(1, 2, 3, 1, 2)}, 1, 2)
    c.layers[0].add = lambda _: zero
    c.layers[1].mult = pred({gate_bits(0, 0, 0, 2, 2), gate_bits(1, 1, 1, 2, 2),
                             gate_bits(2, 1, 2, 2, 2), gate_bits(3, 3, 3, 2, 2)}, 2, 2)
    c.layers[1].add = lambda _: zero
    return c


OUT = [F(36), F(6)]
INP = [F(3), F(2), F(3), F(1)]


def forge_for_legacy(circuit, claimed_output):
    """Builds an upstream-format proof for an arbitrary (false) output that the upstream
    python verifier accepts: D and z0 come from the proof, round polynomials only need
    g(0)+g(1)=claim, the end of each sumcheck is compared with the prover-supplied f, and
    the input polynomial comes from the proof."""
    k = [1, 2, 2]
    d = 3
    D = get_multi_ext(lambda bits: claimed_output[int(bits[0])], 1)
    z = [[F(5)], None, None]
    adds, mults = [], []
    for i in range(d - 1):
        v = k[i] + 2 * k[i + 1]
        adds.append(get_multi_ext(circuit.add_i(i), v))
        mults.append(get_multi_ext(circuit.mult_i(i), v))
    m = legacy_upstream.eval_expansion(D, z[0])
    proofs, rs, f, q, r_stars = [], [], [], [], []
    for i in range(d - 1):
        rounds, r = [], []
        expected = m
        for _ in range(2 * k[i + 1]):
            g = [expected * F(2).inv()]  # constant polynomial, g(0)+g(1)=expected
            rounds.append(g)
            r.append(F(mimc.mimc_hash([int(x) for x in g])))
            expected = g[0]
        q_i = [F(7), F(11)]
        q0, q1 = eval_univariate(q_i, zero), eval_univariate(q_i, one)
        point = z[i] + r
        f.append(legacy_upstream.eval_expansion(adds[i], point) * (q0 + q1)
                 + legacy_upstream.eval_expansion(mults[i], point) * (q0 * q1))
        r_star = F(mimc.mimc_hash([int(x) for x in rounds[-1]]))
        m = eval_univariate(q_i, r_star)
        z[i + 1] = [F(1)] * k[i + 1]
        proofs.append(rounds); rs.append(r); q.append(q_i); r_stars.append(r_star)
    input_func = [[m] + [zero] * k[d - 1]]  # constant "input polynomial" = final claim
    return Proof(proofs, rs, f, D, q, z, r_stars, d, input_func, adds, mults, k)


class TranscriptVectors(unittest.TestCase):
    def test_known_answers_match_rust(self):
        # Same vectors as rust/src/gkr/transcript.rs::vectors::known_answer_vectors.
        self.assertEqual(hex(mimc7(2, 3)), "0x169fb7b0a230e5fa8fba53a45d49e15bb638b970a65854cb3825eb4534d1348d")
        t = Transcript(DOMAIN_PROOF)
        t.absorb([1, 2])
        self.assertEqual(hex(int(t.squeeze())), "0x202baedcc3fd6bd533f6fd9e5a7844027c53062cb07965a0461f244d0078eaab")
        self.assertEqual(hex(int(t.squeeze())), "0x177bbe3904bf1de13a201c6d473c033a36e4fa04b599ffe5bbbef72d9fb306d0")

    def test_circuit_digest_matches_rust(self):
        # rust/tests/verifier.rs::python_example_matches_rust (shared_operands circuit).
        self.assertEqual(hex(int(circuit_digest(example_circuit()))), RUST_EXAMPLE_DIGEST)


RUST_EXAMPLE_DIGEST = "0x23983e6d2fe8b6457bfccb6e299cbfc9b07350b8bb0f798846302b3b46afc5dd"
RUST_EXAMPLE_Q0 = ["0x0",
                  "0x8315e766975844164cd7030350bee8e60b85bcd09e5b693ed3c895fcffd1794",
                  "0x2d4265f26e493d73621ca6b170fbf3c86f0621ac6259d87730fc4484f8e2744c"]


class Fixed(unittest.TestCase):
    def setUp(self):
        self.c = example_circuit()
        self.proof = prove(self.c)

    def test_honest(self):
        self.assertTrue(verify(self.c, OUT, INP, self.proof))

    def test_proof_equals_rust_proof(self):
        # The rust prover on the same circuit/input produces the same first q polynomial.
        self.assertEqual([hex(int(x)) for x in self.proof.q[0]], RUST_EXAMPLE_Q0)

    def test_wrong_output_any_gate(self):
        for i in range(2):
            out = list(OUT)
            out[i] = out[i] + one
            self.assertFalse(verify(self.c, out, INP, self.proof))

    def test_wrong_input(self):
        inp = list(INP)
        inp[3] = inp[3] + one
        self.assertFalse(verify(self.c, OUT, inp, self.proof))

    def test_tampering(self):
        for layer in range(2):
            for rnd in range(len(self.proof.sumcheck_proofs[layer])):
                for j in range(3):
                    p = copy.deepcopy(self.proof)
                    p.sumcheck_proofs[layer][rnd][j] += one
                    self.assertFalse(verify(self.c, OUT, INP, p))
            for j in range(len(self.proof.q[layer])):
                p = copy.deepcopy(self.proof)
                p.q[layer][j] += one
                self.assertFalse(verify(self.c, OUT, INP, p))

    def test_degree_and_round_count(self):
        p = copy.deepcopy(self.proof)
        p.sumcheck_proofs[0][0] = [zero] + p.sumcheck_proofs[0][0]
        self.assertFalse(verify(self.c, OUT, INP, p))
        p = copy.deepcopy(self.proof)
        p.sumcheck_proofs[1] = p.sumcheck_proofs[1][:1]  # upstream v == 1 shortcut
        self.assertFalse(verify(self.c, OUT, INP, p))
        p = copy.deepcopy(self.proof)
        p.q[0] = p.q[0] + [zero]
        self.assertFalse(verify(self.c, OUT, INP, p))

    def test_prover_hints_ignored(self):
        p = copy.deepcopy(self.proof)
        p.z = [[zero], [zero, zero], [zero, zero]]
        p.r, p.sumcheck_r, p.f, p.k, p.d = [one], [], [], [9], 0
        self.assertTrue(verify(self.c, OUT, INP, p))


class LegacyExploit(unittest.TestCase):
    def test_upstream_verifier_accepts_forgery_fixed_rejects(self):
        c = example_circuit()
        false_output = [F(1234), F(5678)]
        forged = forge_for_legacy(c, false_output)
        self.assertTrue(legacy_upstream.verify(forged), "upstream accepted the forgery")
        self.assertFalse(verify(c, false_output, INP, forged))
        # and the forgery is not accepted for the true statement either
        self.assertFalse(verify(c, OUT, INP, forged))


if __name__ == "__main__":
    unittest.main()
