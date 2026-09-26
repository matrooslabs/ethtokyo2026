/// The scoring relation evaluated at the row-sumcheck point (SPEC §5–6; engine `relation.rs`).
/// Tables: 0..3 = lane timelines, 4 = chart, 5 = trace, 6 = byte. `v` holds a table's
/// advice, source and public column values in canonical order.
module mania_gkr::relation;

use mania_gkr::fr::{Self, one, zero};
use sui::bls12381::Scalar;
use sui::group_ops::Element;

use fun fr::add as Element.add;
use fun fr::sub as Element.sub;
use fun fr::mul as Element.mul;

const W: u64 = 136500;
const S16: u64 = 65536;

public fun num_tables(): u64 { 7 }

public fun adv(t: u64): u64 { if (t < 4) 23 else if (t == 4) 32 else if (t == 5) 5 else 1 }

public fun src(t: u64): u64 { if (t < 4) 0 else if (t == 4) 5 else if (t == 5) 3 else 0 }

public fun slots(t: u64): u64 { if (t < 4) 12 else if (t == 4) 18 else if (t == 5) 7 else 1 }

public fun constraints(t: u64): u64 { if (t < 4) 23 else if (t == 4) 25 else if (t == 5) 3 else 0 }

public fun col_slots_log(t: u64): u64 { if (t < 4) 5 else if (t == 4) 5 else if (t == 5) 3 else 0 }

/// Fingerprint powers α^0..α^8 and γ; leaf denominator γ − (tag + Σ α^{i+1} a_i).
public struct Fp has drop {
    alpha: vector<Element<Scalar>>,
    gamma: Element<Scalar>,
}

public fun new_fp(alpha: Element<Scalar>, gamma: Element<Scalar>): Fp {
    let mut pows = vector[one()];
    let mut i = 1;
    while (i < 9) {
        let p = pows[i - 1].mul(&alpha);
        pows.push_back(p);
        i = i + 1;
    };
    Fp { alpha: pows, gamma }
}

fun den(fp: &Fp, tag: &Element<Scalar>, a: &vector<Element<Scalar>>): Element<Scalar> {
    let mut acc = *tag;
    let mut i = 0;
    while (i < a.length()) {
        acc = acc.add(&fp.alpha[i + 1].mul(&a[i]));
        i = i + 1;
    };
    fp.gamma.sub(&acc)
}

/// γ − 9 − α·ℓ (byte lookup slot)
fun den_limb(b: &Batch, limb: &Element<Scalar>): Element<Scalar> {
    b.fp.gamma.sub(&b.k[9]).sub(&b.fp.alpha[1].mul(limb))
}

// Indices into `Batch.k`: 0..=9 are the integers 0..=9.
const K256: u64 = 10;
const KS16: u64 = 11;
const K8W2: u64 = 12;
const K4W1: u64 = 13;
const KHEAD_LO: u64 = 14;
const KHEAD_HI: u64 = 19;
const KTAIL_LO: u64 = 24;
const KTAIL_HI: u64 = 30;

fun consts(): vector<Element<Scalar>> {
    let mut v = vector[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 256, S16, 8 * W + 2, 4 * W + 1];
    v.append(vector[0, 19501, 49501, 82501, 112501]);
    v.append(vector[19500, 49500, 82500, 112500, 136500]);
    v.append(vector[0, 19501, 49501, 82501, 112501, 136501]);
    v.append(vector[19500, 49500, 82500, 112500, 136500, (1u64 << 32) - 1]);
    v.map!(|x| fr::from_u64(x))
}

/// Batching data shared by all tables.
public struct Batch has drop {
    /// Small constants, computed once per proof.
    k: vector<Element<Scalar>>,
    fp: Fp,
    duration: Element<Scalar>,
    /// β^i for the global constraint counter.
    beta: vector<Element<Scalar>>,
    /// χ_s(z) per table and slot.
    chi: vector<vector<Element<Scalar>>>,
    lambda: Element<Scalar>,
    /// κζ^c for c < 5.
    kz: vector<Element<Scalar>>,
}

public fun new_batch(
    fp: Fp,
    duration: u64,
    beta: vector<Element<Scalar>>,
    chi: vector<vector<Element<Scalar>>>,
    lambda: Element<Scalar>,
    kz: vector<Element<Scalar>>,
): Batch {
    Batch { k: consts(), fp, duration: fr::from_u64(duration), beta, chi, lambda, kz }
}

/// Accumulator for Σ β^i C_i and Σ χ_s (p_s + λ q_s).
public struct Acc has drop {
    cons: Element<Scalar>,
    slots: Element<Scalar>,
    ci: u64,
    si: u64,
}

fun c(b: &Batch, acc: &mut Acc, x: Element<Scalar>) {
    acc.cons = acc.cons.add(&b.beta[acc.ci].mul(&x));
    acc.ci = acc.ci + 1;
}

fun s(b: &Batch, t: u64, acc: &mut Acc, p: Element<Scalar>, q: Element<Scalar>) {
    acc.slots = acc.slots.add(&b.chi[t][acc.si].mul(&p.add(&b.lambda.mul(&q))));
    acc.si = acc.si + 1;
}

/// x(x − 1)
fun boolean(x: &Element<Scalar>): Element<Scalar> { x.mul(&x.sub(&one())) }

/// Σ 256^i v[start + i]
fun limbs(b: &Batch, v: &vector<Element<Scalar>>, start: u64, count: u64): Element<Scalar> {
    let base = &b.k[K256];
    let mut acc = zero();
    let mut i = count;
    while (i > 0) {
        i = i - 1;
        acc = acc.mul(base).add(&v[start + i]);
    };
    acc
}

/// f_T = eq_r·Σβ^i C_i + eq_z·Σ_s χ_s(p_s + λq_s) (+ κΣζ^c counts for the chart).
/// `beta_off` is the table's first global constraint index.
public fun table_poly(
    b: &Batch,
    t: u64,
    v: &vector<Element<Scalar>>,
    eq_r: &Element<Scalar>,
    eq_z: &Element<Scalar>,
    beta_off: u64,
): Element<Scalar> {
    let mut acc = Acc { cons: zero(), slots: zero(), ci: beta_off, si: 0 };
    if (t < 4) lane(b, t, v, &mut acc)
    else if (t == 4) chart(b, v, &mut acc)
    else if (t == 5) trace(b, v, &mut acc)
    else s(b, 6, &mut acc, fr::neg(&v[0]), den_limb(b, &v[1]));
    let mut total = eq_r.mul(&acc.cons).add(&eq_z.mul(&acc.slots));
    if (t == 4) {
        let mut k = 0;
        while (k < 5) {
            total = total.add(&b.kz[k].mul(&v[6 + k].add(&v[12 + k])));
            k = k + 1;
        };
    };
    total
}

// Lane columns: isO 0, isC 1, isD 2, isU 3, v 4, q 5, kl 6, O 7, F 8, H 9, A 10, Kx 11,
// lastK 12, inv 13, mD 14, cC 15, ℓ 16..22 | isFirst 23, isLast 24, id 25.
fun lane(b: &Batch, t: u64, v: &vector<Element<Scalar>>, acc: &mut Acc) {
    let one = one();
    let (is_o, is_c, is_d, is_u) = (&v[0], &v[1], &v[2], &v[3]);
    let (vv, q, kl, o, f, h, a, kx, last_k) = (&v[4], &v[5], &v[6], &v[7], &v[8], &v[9], &v[10], &v[11], &v[12]);
    let (inv, md, cc) = (&v[13], &v[14], &v[15]);
    let (is_first, is_last, id) = (&v[23], &v[24], &v[25]);
    let is_real = is_o.add(is_c).add(is_d).add(is_u);
    let ev = is_d.add(is_u);
    // K = S·(4v·isO + (4v+8W+2)·isC + (4v+4W+1)·(isD+isU)) + q·(isD+isU)
    let four_v = vv.mul(&b.k[4]);
    let k = b.k[KS16]
        .mul(
            &four_v.mul(is_o)
                .add(&four_v.add(&b.k[K8W2]).mul(is_c))
                .add(&four_v.add(&b.k[K4W1]).mul(&ev)),
        )
        .add(&q.mul(&ev));
    let o_minus_f = o.sub(f);
    let f_minus_kl = f.sub(kl);
    c(b, acc, boolean(is_o));
    c(b, acc, boolean(is_c));
    c(b, acc, boolean(is_d));
    c(b, acc, boolean(is_u));
    c(b, acc, boolean(&is_real));
    c(b, acc, is_real.mul(&k.sub(last_k).sub(&limbs(b, v, 16, 7))));
    c(b, acc, is_o.mul(&kl.sub(o)));
    c(b, acc, is_d.mul(h));
    c(b, acc, is_u.mul(&one.sub(h)));
    c(b, acc, boolean(md));
    c(b, acc, md.mul(&one.sub(is_d)));
    c(b, acc, is_d.mul(&one.sub(md)).mul(&o_minus_f));
    c(b, acc, md.mul(&o_minus_f.mul(inv).sub(&one)));
    c(b, acc, boolean(cc));
    c(b, acc, cc.mul(&one.sub(is_c)));
    c(b, acc, cc.mul(&f_minus_kl));
    c(b, acc, is_c.sub(cc).mul(&f_minus_kl.mul(inv).sub(&one)));
    let mut col = 7;
    while (col <= 12) {
        c(b, acc, is_first.mul(&v[col]));
        col = col + 1;
    };

    let lane_id = b.k[t];
    let fp = &b.fp;
    let zero = zero();
    let tag = is_o.add(&is_c.mul(&b.k[2])).add(&is_d.mul(&b.k[3])).add(&is_u.mul(&b.k[4]));
    s(b, t, acc, is_real, den(fp, &tag, &vector[lane_id, *vv, *q, *kl]));
    s(b, t, acc, *md, den(fp, &b.k[5], &vector[lane_id, *vv, zero, *f]));
    s(b, t, acc, is_u.mul(a), den(fp, &b.k[6], &vector[lane_id, *vv, zero, *kx]));
    s(
        b,
        t,
        acc,
        is_first.sub(&one),
        den(fp, &b.k[7], &vector[lane_id, *id, *o, *f, *h, *a, *kx, *last_k]),
    );
    let not_event = one.sub(&ev);
    let next = vector[
        lane_id,
        id.add(&one),
        o.add(is_o),
        f.add(md).add(cc),
        h.add(is_d).sub(is_u),
        not_event.mul(a).add(md),
        not_event.mul(kx).add(&md.mul(f)),
        last_k.add(&is_real.mul(&k.sub(last_k))),
    ];
    s(b, t, acc, one.sub(is_last), den(fp, &b.k[7], &next));
    let mut i = 0;
    while (i < 7) {
        s(b, t, acc, one, den_limb(b, &v[16 + i]));
        i = i + 1;
    };
}

// Chart columns: hit 0, th 1, rel 2, u 3, hh 4, σ 5, h 6..10, τ 11, g 12..17, ℓ 18..31 |
// lane 32, s 33, e 34, hold 35, kl 36 | real 37.
fun chart(b: &Batch, v: &vector<Element<Scalar>>, acc: &mut Acc) {
    let one = one();
    let two = b.k[2];
    let (hit, th, rel, u, hh, sigma, tau) = (&v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[11]);
    let (lane_c, s_c, e_c, hold, kl, real) = (&v[32], &v[33], &v[34], &v[35], &v[36], &v[37]);
    c(b, acc, boolean(hit));
    c(b, acc, boolean(rel));
    c(b, acc, rel.mul(&one.sub(hit)));
    c(b, acc, hit.mul(&one.sub(real)));
    c(b, acc, hh.sub(&hit.mul(hold)));
    c(b, acc, boolean(sigma));
    let (mut sum_h, mut lo, mut hi) = (zero(), zero(), zero());
    let mut k = 0;
    while (k < 5) {
        let hk = &v[6 + k];
        c(b, acc, boolean(hk));
        sum_h = sum_h.add(hk);
        lo = lo.add(&hk.mul(&b.k[KHEAD_LO + k]));
        hi = hi.add(&hk.mul(&b.k[KHEAD_HI + k]));
        k = k + 1;
    };
    c(b, acc, sum_h.sub(hit));
    let delta = two.mul(sigma).sub(&one).mul(&th.sub(s_c));
    c(b, acc, delta.sub(&lo).sub(&limbs(b, v, 18, 3)));
    c(b, acc, hi.sub(&delta).sub(&limbs(b, v, 21, 3)));
    c(b, acc, boolean(tau));
    let (mut sum_g, mut lo2, mut hi2) = (zero(), zero(), zero());
    k = 0;
    while (k < 6) {
        let gk = &v[12 + k];
        c(b, acc, boolean(gk));
        sum_g = sum_g.add(gk);
        lo2 = lo2.add(&gk.mul(&b.k[KTAIL_LO + k]));
        hi2 = hi2.add(&gk.mul(&b.k[KTAIL_HI + k]));
        k = k + 1;
    };
    c(b, acc, sum_g.sub(hh));
    c(b, acc, hh.mul(&one.sub(rel)).mul(&one.sub(&v[17])));
    let delta2 = hold.mul(&two.mul(tau).sub(&one)).mul(&u.sub(e_c));
    c(b, acc, delta2.sub(&lo2).sub(&limbs(b, v, 24, 4)));
    c(b, acc, hi2.sub(&delta2).sub(&limbs(b, v, 28, 4)));

    let fp = &b.fp;
    let zero = zero();
    let neg_real = fr::neg(real);
    s(b, 4, acc, neg_real, den(fp, &one, &vector[*lane_c, *s_c, zero, *kl]));
    s(b, 4, acc, neg_real, den(fp, &two, &vector[*lane_c, *s_c, zero, *kl]));
    s(b, 4, acc, fr::neg(hit), den(fp, &b.k[5], &vector[*lane_c, *th, zero, *kl]));
    s(b, 4, acc, fr::neg(&hit.mul(rel)), den(fp, &b.k[6], &vector[*lane_c, *u, zero, *kl]));
    let mut i = 0;
    while (i < 14) {
        s(b, 4, acc, one, den_limb(b, &v[18 + i]));
        i = i + 1;
    };
}

// Trace columns: P 0, d 1..4 | t 5, lane 6, act 7 | real 8, isEnd 9, isFirst 10, idx 11.
fun trace(b: &Batch, v: &vector<Element<Scalar>>, acc: &mut Acc) {
    let one = one();
    let (p, t, lane_c, act, real, is_end, is_first, idx) = (&v[0], &v[5], &v[6], &v[7], &v[8], &v[9], &v[10], &v[11]);
    c(b, acc, real.mul(&t.sub(p)).add(&is_end.mul(&b.duration.sub(p))).sub(&limbs(b, v, 1, 4)));
    c(b, acc, is_first.mul(p));
    c(b, acc, real.mul(act).mul(&act.sub(&one)));

    let fp = &b.fp;
    s(b, 5, acc, fr::neg(real), den(fp, &b.k[3].add(act), &vector[*lane_c, *t, *idx, zero()]));
    s(b, 5, acc, *real, den(fp, &b.k[8], &vector[idx.add(&one), *t]));
    s(
        b,
        5,
        acc,
        fr::neg(&real.add(is_end).mul(&one.sub(is_first))),
        den(fp, &b.k[8], &vector[*idx, *p]),
    );
    let mut i = 0;
    while (i < 4) {
        s(b, 5, acc, one, den_limb(b, &v[1 + i]));
        i = i + 1;
    };
}
