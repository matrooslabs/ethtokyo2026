"""VERBATIM copy of upstream's python verifier (commit 1693f3f), kept ONLY so that
test_security.py can demonstrate that forged proofs were accepted. Do not use."""
from ethsnarks import field, mimc
from poly import eval_univariate, eval_expansion
import time


def verify_sumcheck(claim: field.FQ, proof: list[list[field.FQ]], r, v: int):
    bn = len(proof)
    if(v == 1 and (eval_univariate(proof[0], field.FQ.zero()) + eval_univariate(proof[0], field.FQ.one())) == claim):
        return True
    expected = claim
    for i in range(bn):
        q_zero = eval_univariate(proof[i], field.FQ.zero())
        q_one = eval_univariate(proof[i], field.FQ.one())

        if q_zero + q_one != expected:
            return False
        if field.FQ(mimc.mimc_hash(list(map(lambda x : int(x), proof[i])))) != r[i]:
            return False
        expected = eval_univariate(proof[i], r[i])

    return True


def verify(proof):
    start = time.time()
    m = [field.FQ.zero()]*proof.d
    m[0] = eval_expansion(proof.D, proof.z[0])

    for i in range(proof.d - 1):
        valid = verify_sumcheck(m[i], proof.sumcheck_proofs[i], proof.sumcheck_r[i], 2 * proof.k[i + 1])
        if not valid:
            return False
        else:
            q_i = proof.q[i]
            q_zero = eval_univariate(q_i, field.FQ.zero())
            q_one = eval_univariate(q_i, field.FQ.one())

            modified_f = eval_expansion(proof.add[i], proof.z[i] + proof.sumcheck_r[i]) * (q_zero + q_one) \
                        + eval_expansion(proof.mult[i], proof.z[i] + proof.sumcheck_r[i]) * (q_zero * q_one)

            sumcheck_p = proof.sumcheck_proofs[i]
            sumcheck_p_hash = field.FQ(mimc.mimc_hash(list(map(lambda x : int(x), sumcheck_p[len(sumcheck_p) - 1]))))

            if (proof.f[i] != modified_f) or (sumcheck_p_hash != proof.r[i]):
                print("verifying time :", time.time() - start)
                return False
            else:
                m[i + 1] = eval_univariate(q_i, proof.r[i])
    if m[proof.d - 1] != eval_expansion(proof.input_func, proof.z[proof.d - 1]):
        print("verifying time :", time.time() - start)
        return False
    print("verifying time :", time.time() - start)
    return True
