from poly import *
from util import *

# The GKR sumcheck polynomial add*(W(b)+W(c)) + mult*W(b)*W(c) has degree <= 2 per variable.
ROUND_COEFFS = 3


def normalize(coeffs, length):
    """Left-pad a highest-degree-first coefficient list to exactly `length` entries."""
    coeffs = list(coeffs)
    while coeffs and coeffs[0] == field.FQ.zero():
        coeffs = coeffs[1:]
    if len(coeffs) > length:
        raise ValueError("polynomial exceeds degree bound")
    return [field.FQ.zero()] * (length - len(coeffs)) + coeffs


def prove_sumcheck(g: polynomial, v: int, start: int, transcript):
    """Each round polynomial is absorbed into the running transcript before its challenge
    is squeezed (upstream hashed only the current message)."""
    proof = []
    r = []

    def send(coeffs):
        coeffs = normalize(coeffs, ROUND_COEFFS)
        transcript.absorb(coeffs)
        proof.append(coeffs)
        r.append(transcript.squeeze())

    # first round
    # g1(X1)=∑(x2,⋯,xv)∈{0,1}^v g(X_1,x_2,⋯,x_v)
    g_1 = polynomial([])
    assignments = generate_binary(v - 1)
    for assignment in assignments:
        g_1_sub = polynomial(g.terms[:], g.constant)
        for i, x_i in enumerate(assignment):
            idx = i + 1 + start
            g_1_sub = g_1_sub.eval_i(x_i, idx)
        g_1 += g_1_sub
    send(g_1.get_all_coefficients())

    # 1 < j < v round
    for j in range(1, v - 1):
        g_j = polynomial(g.terms[:], g.constant)
        assignments = generate_binary(v - j - 1)
        for i, r_i in enumerate(r):
            idx = i + start
            g_j = g_j.eval_i(r_i, idx)

        res_g_j = polynomial([])
        for assignment in assignments:
            g_j_sub = polynomial(g_j.terms[:], g_j.constant)
            for k, x_i in enumerate(assignment):
                idx = j + k + start + 1
                g_j_sub = g_j_sub.eval_i(x_i, idx)
            res_g_j += g_j_sub
        send(res_g_j.get_all_coefficients())

    g_v = polynomial(g.terms[:], g.constant)
    for i, r_i in enumerate(r):
        idx = i + start
        g_v = g_v.eval_i(r_i, idx)
    send(g_v.get_all_coefficients())

    return proof, r


def verify_sumcheck(claim: field.FQ, proof, v: int, transcript):
    """Returns (final_claim, challenges) or None.

    Fixed vs upstream: exactly v rounds (the `v == 1` shortcut accepted without any
    challenge), exact degree bound, challenges recomputed from the transcript, and the
    final evaluation g_v(r_v) is returned so the caller can bind it to the circuit.
    """
    if len(proof) != v:
        return None
    expected = claim
    r = []
    for g in proof:
        if len(g) != ROUND_COEFFS:
            return None
        g = [field.FQ(int(c)) for c in g]
        if eval_univariate(g, field.FQ.zero()) + eval_univariate(g, field.FQ.one()) != expected:
            return None
        transcript.absorb(g)
        r_i = transcript.squeeze()
        r.append(r_i)
        expected = eval_univariate(g, r_i)
    return expected, r
