/// Multilinear/univariate helpers (engine `mle.rs`, `poly.rs`). Variable x_0 is the
/// least-significant index bit.
module mania_gkr::mle;

use mania_gkr::fr::{Self, one, zero, one_minus};
use sui::bls12381::Scalar;
use sui::group_ops::Element;

use fun fr::add as Element.add;
use fun fr::sub as Element.sub;
use fun fr::mul as Element.mul;

/// eq(a, b) = ab + (1−a)(1−b) = 1 − a − b + 2ab
public fun eq1(a: &Element<Scalar>, b: &Element<Scalar>): Element<Scalar> {
    let ab = a.mul(b);
    one().sub(a).sub(b).add(&ab).add(&ab)
}

/// Π_j eq(a[ao + j], b[bo + j]) for j < len.
public fun eq_range(
    a: &vector<Element<Scalar>>,
    ao: u64,
    b: &vector<Element<Scalar>>,
    bo: u64,
    len: u64,
): Element<Scalar> {
    let mut acc = one();
    let mut j = 0;
    while (j < len) {
        acc = acc.mul(&eq1(&a[ao + j], &b[bo + j]));
        j = j + 1;
    };
    acc
}

/// eq(bits(c), x[off..off+len])
public fun eq_const(c: u64, x: &vector<Element<Scalar>>, off: u64, len: u64): Element<Scalar> {
    let mut acc = one();
    let mut j = 0;
    while (j < len) {
        let xj = &x[off + j];
        acc = if ((c >> (j as u8)) & 1 == 1) acc.mul(xj) else acc.mul(&one_minus(xj));
        j = j + 1;
    };
    acc
}

/// T[i] = eq(bits(i), x[off..off+len]) for i < 2^len.
public fun eq_table(x: &vector<Element<Scalar>>, off: u64, len: u64): vector<Element<Scalar>> {
    let mut table = vector[one()];
    let mut j = len;
    while (j > 0) {
        j = j - 1;
        let p = &x[off + j];
        let mut next = vector[];
        let mut i = 0;
        let size = table.length();
        while (i < size) {
            let hi = table[i].mul(p);
            next.push_back(table[i].sub(&hi));
            next.push_back(hi);
            i = i + 1;
        };
        table = next;
    };
    table
}

/// eq(bits(k), x[off..off+len]) for consecutive k without a 2^len table: a low table over
/// up to 10 variables times a cached factor for the high variables.
public struct EqRows has drop {
    x: vector<Element<Scalar>>,
    off: u64,
    len: u64,
    low_bits: u64,
    low: vector<Element<Scalar>>,
    high_index: u64,
    high: Element<Scalar>,
}

public fun new_eq_rows(x: &vector<Element<Scalar>>, off: u64, len: u64): EqRows {
    let low_bits = if (len < 10) len else 10;
    EqRows {
        x: *x,
        off,
        len,
        low_bits,
        low: eq_table(x, off, low_bits),
        high_index: 0,
        high: eq_const(0, x, off + low_bits, len - low_bits),
    }
}

public fun at(r: &mut EqRows, k: u64): Element<Scalar> {
    let hi = k >> (r.low_bits as u8);
    if (hi != r.high_index) {
        r.high_index = hi;
        r.high = eq_const(hi, &r.x, r.off + r.low_bits, r.len - r.low_bits);
    };
    r.low[k & ((1 << (r.low_bits as u8)) - 1)].mul(&r.high)
}

/// Π_{j ≥ from} (1 − x_j)
public fun pad_factor(x: &vector<Element<Scalar>>, from: u64): Element<Scalar> {
    let n = x.length();
    if (from >= n) return one();
    fr::prod_one_minus(x, from, n - from)
}

/// MLE of i ↦ i over x[0..len].
public fun id_mle(x: &vector<Element<Scalar>>, len: u64): Element<Scalar> {
    let mut acc = zero();
    let mut pow = one();
    let two = fr::from_u64(2);
    let mut j = 0;
    while (j < len) {
        acc = acc.add(&pow.mul(&x[j]));
        pow = pow.mul(&two);
        j = j + 1;
    };
    acc
}

/// MLE of i ↦ [i < n] over x[0..k] (n ≤ 2^k, else 1).
public fun step_mle(n: u64, x: &vector<Element<Scalar>>, k: u64): Element<Scalar> {
    if (k < 64 && n >= (1u64 << (k as u8))) return one();
    let mut acc = zero();
    let mut prefix = one();
    let mut j = k;
    while (j > 0) {
        j = j - 1;
        if ((n >> (j as u8)) & 1 == 1) {
            acc = acc.add(&prefix.mul(&one_minus(&x[j])));
            prefix = prefix.mul(&x[j]);
        } else {
            prefix = prefix.mul(&one_minus(&x[j]));
        }
    };
    acc
}

public fun log2_ceil(n: u64): u64 {
    let mut k = 0;
    while ((1u64 << (k as u8)) < n) k = k + 1;
    k
}

/// Nodes 0..=4 and inverse Lagrange denominators 1/Π_{j≠i}(i−j) for d = 2, 3, 4.
public struct Lagrange has drop {
    nodes: vector<Element<Scalar>>,
    d2: vector<Element<Scalar>>,
    d3: vector<Element<Scalar>>,
    d4: vector<Element<Scalar>>,
}

fun dens(nodes: &vector<Element<Scalar>>, d: u64): vector<Element<Scalar>> {
    let mut out = vector[];
    let mut i = 0;
    while (i <= d) {
        let mut den = one();
        let mut j = 0;
        while (j <= d) {
            if (j != i) den = den.mul(&nodes[i].sub(&nodes[j]));
            j = j + 1;
        };
        out.push_back(fr::inv(&den));
        i = i + 1;
    };
    out
}

public fun lagrange(): Lagrange {
    let nodes = vector::tabulate!(5, |i| fr::from_u64(i));
    Lagrange { d2: dens(&nodes, 2), d3: dens(&nodes, 3), d4: dens(&nodes, 4), nodes }
}

/// g(r) from g(0..=d); exact at every r (no r-dependent inversions).
public fun interpolate(l: &Lagrange, evals: &vector<Element<Scalar>>, r: &Element<Scalar>): Element<Scalar> {
    let d = evals.length() - 1;
    let den = if (d == 2) &l.d2 else if (d == 3) &l.d3 else &l.d4;
    // prefix_i = Π_{j<i} (r − j); the suffix product runs backwards.
    let mut prefix = vector[one()];
    let mut j = 0;
    while (j < d) {
        let p = prefix[j].mul(&r.sub(&l.nodes[j]));
        prefix.push_back(p);
        j = j + 1;
    };
    let mut acc = zero();
    let mut suffix = one();
    let mut i = d + 1;
    while (i > 0) {
        i = i - 1;
        acc = acc.add(&evals[i].mul(&prefix[i].mul(&suffix).mul(&den[i])));
        suffix = suffix.mul(&r.sub(&l.nodes[i]));
    };
    acc
}

/// [g(0), claim − g(0), g(2), …] from the compressed round message.
public fun decompress(claim: &Element<Scalar>, sent: &vector<Element<Scalar>>): vector<Element<Scalar>> {
    let mut evals = vector[sent[0], claim.sub(&sent[0])];
    let mut i = 1;
    while (i < sent.length()) {
        evals.push_back(sent[i]);
        i = i + 1;
    };
    evals
}

#[test_only]
/// f(x) = 3x^3 + 5x + 7
fun cubic(x: u64): Element<Scalar> { fr::from_u64(3 * x * x * x + 5 * x + 7) }

#[test]
fun interpolation_recovers_cubic() {
    let l = lagrange();
    let evals = vector[cubic(0), cubic(1), cubic(2), cubic(3)];
    assert!(fr::eq(&interpolate(&l, &evals, &fr::from_u64(9)), &cubic(9)));
    assert!(fr::eq(&interpolate(&l, &evals, &fr::from_u64(2)), &cubic(2)));
    let evals4 = vector[cubic(0), cubic(1), cubic(2), cubic(3), cubic(4)];
    assert!(fr::eq(&interpolate(&l, &evals4, &fr::from_u64(11)), &cubic(11)));
}

#[test]
fun public_mles() {
    let x = vector[fr::from_u64(0), fr::from_u64(1), fr::from_u64(1)]; // index 6
    assert!(fr::eq(&id_mle(&x, 3), &fr::from_u64(6)));
    assert!(fr::eq(&step_mle(7, &x, 3), &one()));
    assert!(fr::eq(&step_mle(6, &x, 3), &zero()));
    assert!(fr::eq(&eq_const(6, &x, 0, 3), &one()));
    assert!(fr::eq(&eq_const(5, &x, 0, 3), &zero()));
    let t = eq_table(&x, 0, 3);
    assert!(fr::eq(&t[6], &one()) && fr::eq(&t[5], &zero()));
    assert!(log2_ceil(1) == 0 && log2_ceil(5) == 3 && log2_ceil(8) == 3);
}
