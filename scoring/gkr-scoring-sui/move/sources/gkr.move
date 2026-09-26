/// Fractional-sum GKR verifier (SPEC §7.2 step 3; engine `logup_gkr::verify`).
module mania_gkr::gkr;

use mania_gkr::fr;
use mania_gkr::mle::{Self, Lagrange};
use mania_gkr::reader::{Self, Reader};
use mania_gkr::transcript::{Self, Transcript};
use sui::bls12381::Scalar;
use sui::group_ops::Element;

use fun fr::add as Element.add;
use fun fr::sub as Element.sub;
use fun fr::mul as Element.mul;

const ENonZeroSum: u64 = 1;
const EZeroDenominator: u64 = 2;
const ELayerCheck: u64 = 3;
const EEmptyLayer: u64 = 4;

public struct GkrOutput has drop {
    point: vector<Element<Scalar>>,
    p: Element<Scalar>,
    q: Element<Scalar>,
}

public fun point(o: &GkrOutput): &vector<Element<Scalar>> { &o.point }

public fun p(o: &GkrOutput): &Element<Scalar> { &o.p }

public fun q(o: &GkrOutput): &Element<Scalar> { &o.q }

/// a + τ(b − a)
fun line(a: &Element<Scalar>, b: &Element<Scalar>, tau: &Element<Scalar>): Element<Scalar> {
    a.add(&tau.mul(&b.sub(a)))
}

/// Reads and verifies the GKR section for 2^g leaves; returns the leaf claims.
public fun verify(r: &mut Reader, g: u64, tr: &mut Transcript, lag: &Lagrange): GkrOutput {
    assert!(g >= 1, EEmptyLayer);
    let l1 = reader::scalars(r, 4);
    let (p0, p1, q0, q1) = (&l1[0], &l1[1], &l1[2], &l1[3]);
    assert!(fr::is_zero(&p0.mul(q1).add(&p1.mul(q0))), ENonZeroSum);
    assert!(!fr::is_zero(&q0.mul(q1)), EZeroDenominator);
    transcript::absorb_scalars(tr, &l1);
    let tau = transcript::squeeze(tr);
    let mut point = vector[tau];
    let mut claim_p = line(p0, p1, &tau);
    let mut claim_q = line(q0, q1, &tau);
    let mut k = 1;
    while (k < g) {
        let lambda = transcript::squeeze(tr);
        let mut claim = claim_p.add(&lambda.mul(&claim_q));
        let mut rho = vector[];
        let mut j = 0;
        while (j < k) {
            let sent = reader::scalars(r, 3);
            transcript::absorb_scalars(tr, &sent);
            let evals = mle::decompress(&claim, &sent);
            let x = transcript::squeeze(tr);
            claim = mle::interpolate(lag, &evals, &x);
            rho.push_back(x);
            j = j + 1;
        };
        let ch = reader::scalars(r, 4);
        let (a0, a1, b0, b1) = (&ch[0], &ch[1], &ch[2], &ch[3]);
        let inner = a0.mul(b1).add(&a1.mul(b0)).add(&lambda.mul(b0).mul(b1));
        let expected = mle::eq_range(&point, 0, &rho, 0, k).mul(&inner);
        assert!(fr::eq(&claim, &expected), ELayerCheck);
        transcript::absorb_scalars(tr, &ch);
        let tau = transcript::squeeze(tr);
        point = vector[tau];
        point.append(rho);
        claim_p = line(a0, a1, &tau);
        claim_q = line(b0, b1, &tau);
        k = k + 1;
    };
    GkrOutput { point, p: claim_p, q: claim_q }
}
