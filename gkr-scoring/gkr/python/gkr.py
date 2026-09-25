import math
import time
from poly import *
from sumcheck import *
from transcript import Transcript, DOMAIN_PROOF, DOMAIN_CIRCUIT

class Node:
  def __init__(self, binary_index: list[int], value, left=None, right=None):
    self.binary_index = binary_index
    self.value = value
    self.left = left
    self.right = right

class Layer:
    def __init__(self) -> None:
        self.nodes = []

    def def_mult(self, mult):
        self.mult = mult

    def def_add(self, add):
        self.add = add

    def get_node(self, index) -> Node:
        return self.nodes[index]

    def add_node(self, index, node) -> None:
        self.nodes.insert(index, node)

    def add_func(self, func):
        self.func = func

    def len(self):
        return len(self.nodes)

class Circuit:
    def __init__(self, depth):
        layers = []
        for _ in range(depth):
            layers.append(Layer())
        self.layers : list[Layer] = layers # type: ignore
    
    def get_node(self, layer, index):
        return self.layers[layer].get_node(index)

    def add_node(self, layer, index, binary_index, value, left=None, right=None):
        self.layers[layer].add_node(index, Node(binary_index, value, left, right))

    def depth(self):
        return len(self.layers)

    def layer_length(self, layer):
        return self.layers[layer].len()
    
    def k_i(self, layer):
        return int(math.log2(self.layer_length(layer)))

    def add_i(self, i):
        return self.layers[i].add
    
    def mult_i(self, i):
        return self.layers[i].mult
    
    def w_i(self, i):
        return self.layers[i].func


def reduce_multiple_polynomial(b: list[field.FQ], c: list[field.FQ], w: polynomial) -> list[field.FQ]:
    assert(len(b) == len(c))
    t = []
    new_poly_terms = []
    for b_i, c_i in zip(b, c):
        new_const = b_i
        gradient = c_i - b_i
        t.append(term(gradient, 1, new_const))
    
    for mono in w.terms:
        new_terms = []
        for each in mono.terms:
            new_term = t[each.x_i - 1] * each.coeff
            new_term.const += each.const
            new_terms.append(new_term)
        new_poly_terms.append(monomial(mono.coeff, new_terms))

    poly = polynomial(new_poly_terms, w.constant)
    return poly.get_all_coefficients()

# reduce verification at two points into verification at a single point
def ell(p1: list[field.FQ], p2: list[field.FQ], t: field.FQ):
    consts = p1
    output = [field.FQ.zero()]*len(p2)
    other_term = [field.FQ.zero()]*len(p2)
    for i in range(len(p2)):
        other_term[i] = p2[i] - consts[i]
    for i in range(len(p2)):
        output[i] = consts[i] + t*other_term[i]
    return output


class Proof:
    """Only `sumcheck_proofs` and `q` are read by `verify`; every other field is a
    prover-side debug hint that the verifier recomputes and never trusts (upstream's
    verifier read D, z, r, add, mult, k and input_func from here)."""

    def __init__(self, proofs, r, f, D, q, z, r_stars, d, w, adds, mults, k) -> None:
      self.sumcheck_proofs : list[list[list[field.FQ]]] = proofs
      self.sumcheck_r : list[list[field.FQ]] = r
      self.f : list[field.FQ] = f
      self.D : list[list[field.FQ]] = D
      self.q : list[list[field.FQ]] = q
      self.z : list[list[field.FQ]] = z
      self.r : list[field.FQ] = r_stars

      # circuit info
      self.d : int = d
      self.input_func : list[list[field.FQ]] = w
      self.add : list[list[list[field.FQ]]] = adds
      self.mult : list[list[list[field.FQ]]] = mults
      self.k : list[int] = k

    def to_dict(self):
        to_serialize = dict()
        to_serialize['sumcheckProof'] = list(map(lambda x: list(map(lambda y: list(map(lambda z: repr(z), y)), x)), self.sumcheck_proofs))
        to_serialize['sumcheckr'] = list(map(lambda x: list(map(lambda y: repr(y), x)), self.sumcheck_r))
        to_serialize['f'] = list(map(lambda x: repr(x), self.f))
        to_serialize['q'] = list(map(lambda x: list(map(lambda y: repr(y), x)), self.q))
        to_serialize['z'] = list(map(lambda x: list(map(lambda y: repr(y), x)), self.z))
        to_serialize['D'] = list(map(lambda x: list(map(lambda y: repr(y), x)), self.D))
        to_serialize['r'] = list(map(lambda x: repr(x), self.r))
        to_serialize['inputFunc'] = list(map(lambda x: list(map(lambda y: repr(y), x)), self.input_func))
        to_serialize['add'] = list(map(lambda x: list(map(lambda y: list(map(lambda z: repr(z), y)), x)), self.add))
        to_serialize['mult'] = list(map(lambda x: list(map(lambda y: list(map(lambda z: repr(z), y)), x)), self.mult))
        return to_serialize


def _bits(value, k):
    return [field.FQ((value >> (k - 1 - j)) & 1) for j in range(k)]


def _values(func, k):
    return [func(_bits(i, k)) for i in range(1 << k)]


def gates(circuit: Circuit, i):
    """(add gates, mult gates) of layer i as (z, b, c) triples, MSB-first bit order."""
    kz, kn = circuit.k_i(i), circuit.k_i(i + 1)
    out = ([], [])
    for z in range(1 << kz):
        for b in range(1 << kn):
            for c in range(1 << kn):
                bits = _bits(z, kz) + _bits(b, kn) + _bits(c, kn)
                for slot, pred in enumerate((circuit.add_i(i), circuit.mult_i(i))):
                    v = pred(bits)
                    if v == field.FQ.one():
                        out[slot].append((z, b, c))
                    elif v is not None and v != field.FQ.zero():
                        raise ValueError("wiring predicates must be 0/1")
    return out


def circuit_digest(circuit: Circuit):
    """Same digest as GKRCircuit::digest in rust/src/gkr.rs."""
    t = Transcript(DOMAIN_CIRCUIT)
    depth = circuit.depth() - 1
    t.absorb([depth] + [circuit.k_i(i) for i in range(circuit.depth())])
    for i in range(depth):
        for gate_list in gates(circuit, i):
            t.absorb([x for g in gate_list for x in g])
    t.absorb([])  # fixed (constant) input positions: none in python circuits
    return t.squeeze()


def start_transcript(circuit: Circuit, input_values, output_values):
    t = Transcript(DOMAIN_PROOF)
    t.absorb([circuit_digest(circuit)])
    t.absorb(input_values)
    t.absorb(output_values)
    return t


def mle(values, point):
    """Multilinear extension (MSB-first variable order)."""
    assert len(values) == 1 << len(point)
    cur = [field.FQ(int(v)) for v in values]
    for x in point:
        half = len(cur) // 2
        cur = [cur[i] + (cur[i + half] - cur[i]) * x for i in range(half)]
    return cur[0]


def eq_index(index, x):
    n = len(x)
    acc = field.FQ.one()
    for j, xj in enumerate(x):
        acc *= xj if (index >> (n - 1 - j)) & 1 else field.FQ.one() - xj
    return acc


def wiring_eval(gate_list, z, b, c):
    acc = field.FQ.zero()
    for gz, gb, gc in gate_list:
        acc += eq_index(gz, z) * eq_index(gb, b) * eq_index(gc, c)
    return acc


def prove(circuit: Circuit, D=None):
    """Fiat-Shamir GKR prover. `D` is accepted for backwards compatibility and ignored:
    the output is the circuit's own layer-0 values (bound into the transcript)."""
    start_time = time.time()
    depth = circuit.depth()
    output_values = _values(circuit.w_i(0), circuit.k_i(0))
    input_values = _values(circuit.w_i(depth - 1), circuit.k_i(depth - 1))
    transcript = start_transcript(circuit, input_values, output_values)

    z = [[]] * depth
    z[0] = transcript.squeeze_n(circuit.k_i(0))  # upstream: prover-chosen random point
    sumcheck_proofs = []
    q = []
    f_res = []
    sumcheck_r = []
    r_stars = []

    for i in range(depth - 1):
        if circuit.k_i(i + 1) == 0:
            raise ValueError("layers below the output need >= 2 gates")
        add_i_ext = get_ext(circuit.add_i(i), circuit.k_i(i) + 2 * circuit.k_i(i + 1))
        for j, r in enumerate(z[i]):
            add_i_ext = add_i_ext.eval_i(r, j + 1)

        mult_i_ext = get_ext(circuit.mult_i(i), circuit.k_i(i) + 2 * circuit.k_i(i + 1))
        for j, r in enumerate(z[i]):
            mult_i_ext = mult_i_ext.eval_i(r, j + 1)

        w_i_ext_b = get_ext_from_k(circuit.w_i(i + 1), circuit.k_i(i + 1), circuit.k_i(i) + 1)
        w_i_ext_c = get_ext_from_k(circuit.w_i(i + 1), circuit.k_i(i + 1), circuit.k_i(i) + circuit.k_i(i + 1) + 1)

        first = add_i_ext * (w_i_ext_b + w_i_ext_c)
        second = mult_i_ext * w_i_ext_b * w_i_ext_c
        f = first + second

        start_idx = circuit.k_i(i) + 1

        sumcheck_proof, r = prove_sumcheck(f, 2 * circuit.k_i(i + 1), start_idx, transcript)
        sumcheck_proofs.append(sumcheck_proof)
        sumcheck_r.append(r)

        b_star = r[0: circuit.k_i(i + 1)]
        c_star = r[circuit.k_i(i + 1):(2 * circuit.k_i(i + 1))]

        next_w = get_ext(circuit.w_i(i + 1), circuit.k_i(i + 1))
        q_i = normalize(reduce_multiple_polynomial(b_star, c_star, next_w), circuit.k_i(i + 1) + 1)
        transcript.absorb(q_i)
        q.append(q_i)
        f_res.append(eval_univariate(sumcheck_proof[-1], r[-1]))

        r_star = transcript.squeeze()  # upstream: MiMC(last sumcheck message) only
        z[i + 1] = ell(b_star, c_star, r_star)
        r_stars.append(r_star)

    k = [circuit.k_i(i) for i in range(depth)]
    proof = Proof(sumcheck_proofs, sumcheck_r, f_res, None, q, z, r_stars, depth, None, None, None, k)
    print("proving time :", time.time() - start_time)
    return proof


def verify(circuit: Circuit, output_values, input_values, proof: Proof):
    """Sound verifier: the circuit, claimed output and input come from the caller; every
    challenge is recomputed; each layer's sumcheck end value is bound to the circuit's
    own add~/mult~ wiring; the last claim is checked against the caller's input MLE."""
    depth = circuit.depth() - 1
    k = [circuit.k_i(i) for i in range(circuit.depth())]
    if len(output_values) != 1 << k[0] or len(input_values) != 1 << k[depth]:
        return False
    if len(proof.sumcheck_proofs) != depth or len(proof.q) != depth:
        return False
    try:
        transcript = start_transcript(circuit, input_values, output_values)
    except ValueError:
        return False
    z = transcript.squeeze_n(k[0])
    claim = mle(output_values, z)
    for i in range(depth):
        if k[i + 1] == 0:
            return False
        res = verify_sumcheck(claim, proof.sumcheck_proofs[i], 2 * k[i + 1], transcript)
        if res is None:
            return False
        claim, r = res
        b_star, c_star = r[:k[i + 1]], r[k[i + 1]:]
        q_i = proof.q[i]
        if len(q_i) != k[i + 1] + 1:
            return False
        q_i = [field.FQ(int(c)) for c in q_i]
        q_zero = eval_univariate(q_i, field.FQ.zero())
        q_one = eval_univariate(q_i, field.FQ.one())
        add_g, mult_g = gates(circuit, i)
        expected = wiring_eval(add_g, z, b_star, c_star) * (q_zero + q_one) \
            + wiring_eval(mult_g, z, b_star, c_star) * (q_zero * q_one)
        if expected != claim:  # upstream compared against prover-supplied proof.f[i]
            return False
        transcript.absorb(q_i)
        r_star = transcript.squeeze()
        claim = eval_univariate(q_i, r_star)
        z = ell(b_star, c_star, r_star)
    return claim == mle(input_values, z)
