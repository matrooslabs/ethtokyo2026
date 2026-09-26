//! GKR for fractional sums Σ p_i / q_i (SPEC §7.2 step 3).
//!
//! Layer k has 2^k nodes; node x combines children 2x, 2x+1 of layer k+1:
//! p = p_{2x} q_{2x+1} + p_{2x+1} q_{2x},  q = q_{2x} q_{2x+1}.
use crate::field::{Field, F};
use crate::mle::{eq_eval, eq_table, fold};
use crate::poly::{compress, decompress, interpolate};
use crate::transcript::Transcript;
use anyhow::{ensure, Result};
use rayon::prelude::*;

#[derive(Clone, Debug, PartialEq)]
pub struct LayerProof {
    /// k rounds, each [g(0), g(2), g(3)].
    pub rounds: Vec<[F; 3]>,
    /// Children at (0,ρ), (1,ρ): [p0, p1, q0, q1].
    pub children: [F; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct GkrProof {
    pub layer1: [F; 4],
    pub layers: Vec<LayerProof>,
}

pub struct GkrOutput {
    pub point: Vec<F>,
    pub p: F,
    pub q: F,
}

fn combine(p: &[F], q: &[F]) -> (Vec<F>, Vec<F>) {
    let n = p.len() / 2;
    (0..n)
        .into_par_iter()
        .map(|x| {
            let (p0, p1, q0, q1) = (p[2 * x], p[2 * x + 1], q[2 * x], q[2 * x + 1]);
            (p0 * q1 + p1 * q0, q0 * q1)
        })
        .unzip()
}

fn split(v: &[F]) -> (Vec<F>, Vec<F>) {
    v.par_chunks(2).map(|c| (c[0], c[1])).unzip()
}

/// Evaluations at t = 0..=3 of Σ_i eq(t)(P0 Q1 + P1 Q0 + λ Q0 Q1) for the current round.
fn round_evals(eq: &[F], p0: &[F], p1: &[F], q0: &[F], q1: &[F], lambda: F) -> [F; 4] {
    let half = eq.len() / 2;
    (0..half)
        .into_par_iter()
        .fold(
            || [F::ZERO; 4],
            |mut acc, i| {
                let (a, b) = (2 * i, 2 * i + 1);
                let d = [
                    eq[b] - eq[a],
                    p0[b] - p0[a],
                    p1[b] - p1[a],
                    q0[b] - q0[a],
                    q1[b] - q1[a],
                ];
                let mut v = [eq[a], p0[a], p1[a], q0[a], q1[a]];
                for slot in acc.iter_mut() {
                    *slot += v[0] * (v[1] * v[4] + v[2] * v[3] + lambda * v[3] * v[4]);
                    for (x, dx) in v.iter_mut().zip(d.iter()) {
                        *x += dx;
                    }
                }
                acc
            },
        )
        .reduce(
            || [F::ZERO; 4],
            |mut a, b| {
                for (x, y) in a.iter_mut().zip(b) {
                    *x += y;
                }
                a
            },
        )
}

pub fn prove(p_leaves: Vec<F>, q_leaves: Vec<F>, tr: &mut Transcript) -> (GkrProof, GkrOutput) {
    let g = p_leaves.len().trailing_zeros() as usize;
    assert!(g >= 1 && p_leaves.len() == 1 << g && q_leaves.len() == p_leaves.len());
    // layers[k] = (p, q) of size 2^k
    let mut layers: Vec<(Vec<F>, Vec<F>)> = vec![(Vec::new(), Vec::new()); g + 1];
    layers[g] = (p_leaves, q_leaves);
    for k in (1..g).rev() {
        let (p, q) = combine(&layers[k + 1].0, &layers[k + 1].1);
        layers[k] = (p, q);
    }
    let layer1 = [
        layers[1].0[0],
        layers[1].0[1],
        layers[1].1[0],
        layers[1].1[1],
    ];
    tr.absorb(&layer1);
    let tau = tr.squeeze();
    let mut point = vec![tau];
    let mut claim_p = layer1[0] + tau * (layer1[1] - layer1[0]);
    let mut claim_q = layer1[2] + tau * (layer1[3] - layer1[2]);
    let mut proofs = Vec::with_capacity(g.saturating_sub(1));
    for k in 1..g {
        let lambda = tr.squeeze();
        let mut claim = claim_p + lambda * claim_q;
        let (mut p0, mut p1) = split(&layers[k + 1].0);
        let (mut q0, mut q1) = split(&layers[k + 1].1);
        let mut eq = eq_table(&point);
        let mut rounds = Vec::with_capacity(k);
        let mut rho = Vec::with_capacity(k);
        for _ in 0..k {
            let evals = round_evals(&eq, &p0, &p1, &q0, &q1, lambda);
            debug_assert_eq!(evals[0] + evals[1], claim);
            let sent = compress(&evals);
            tr.absorb(&sent);
            rounds.push([sent[0], sent[1], sent[2]]);
            let r = tr.squeeze();
            claim = interpolate(&evals, r);
            eq = fold(&eq, r);
            p0 = fold(&p0, r);
            p1 = fold(&p1, r);
            q0 = fold(&q0, r);
            q1 = fold(&q1, r);
            rho.push(r);
        }
        let children = [p0[0], p1[0], q0[0], q1[0]];
        debug_assert_eq!(
            claim,
            eq[0]
                * (children[0] * children[3]
                    + children[1] * children[2]
                    + lambda * children[2] * children[3])
        );
        tr.absorb(&children);
        let tau = tr.squeeze();
        point = std::iter::once(tau).chain(rho).collect();
        claim_p = children[0] + tau * (children[1] - children[0]);
        claim_q = children[2] + tau * (children[3] - children[2]);
        proofs.push(LayerProof { rounds, children });
    }
    (
        GkrProof {
            layer1,
            layers: proofs,
        },
        GkrOutput {
            point,
            p: claim_p,
            q: claim_q,
        },
    )
}

pub fn verify(proof: &GkrProof, g: usize, tr: &mut Transcript) -> Result<GkrOutput> {
    ensure!(g >= 1, "empty leaf layer");
    ensure!(proof.layers.len() == g - 1, "wrong number of GKR layers");
    let [p0, p1, q0, q1] = proof.layer1;
    ensure!(p0 * q1 + p1 * q0 == F::ZERO, "fractional sum is not zero");
    ensure!(!bool::from((q0 * q1).is_zero()), "zero denominator at root");
    tr.absorb(&proof.layer1);
    let tau = tr.squeeze();
    let mut point = vec![tau];
    let mut claim_p = p0 + tau * (p1 - p0);
    let mut claim_q = q0 + tau * (q1 - q0);
    for (idx, layer) in proof.layers.iter().enumerate() {
        let k = idx + 1;
        ensure!(layer.rounds.len() == k, "wrong number of sumcheck rounds");
        let lambda = tr.squeeze();
        let mut claim = claim_p + lambda * claim_q;
        let mut rho = Vec::with_capacity(k);
        for sent in &layer.rounds {
            tr.absorb(sent);
            let evals = decompress(claim, sent);
            let r = tr.squeeze();
            claim = interpolate(&evals, r);
            rho.push(r);
        }
        let [a0, a1, b0, b1] = layer.children;
        let expected = eq_eval(&point, &rho) * (a0 * b1 + a1 * b0 + lambda * b0 * b1);
        ensure!(claim == expected, "GKR layer {k} final check failed");
        tr.absorb(&layer.children);
        let tau = tr.squeeze();
        point = std::iter::once(tau).chain(rho).collect();
        claim_p = a0 + tau * (a1 - a0);
        claim_q = b0 + tau * (b1 - b0);
    }
    Ok(GkrOutput {
        point,
        p: claim_p,
        q: claim_q,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mle::mle_eval;
    use rand::SeedableRng;

    fn instance(g: usize, seed: u64) -> (Vec<F>, Vec<F>) {
        // Pairs (x, +1) and (x, -1) cancel: Σ p/q = 0 with q = γ - x.
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);
        let n = 1 << g;
        let gamma = F::random(&mut rng);
        let mut p = Vec::with_capacity(n);
        let mut q = Vec::with_capacity(n);
        for i in 0..n / 2 {
            let x = F::from((i % 7) as u64);
            p.push(F::ONE);
            q.push(gamma - x);
            p.push(-F::ONE);
            q.push(gamma - x);
        }
        (p, q)
    }

    #[test]
    fn honest_proofs_verify_and_bind_leaves() {
        for g in 1..=9 {
            let (p, q) = instance(g, g as u64);
            let mut tp = Transcript::new(b"t");
            let (proof, out) = prove(p.clone(), q.clone(), &mut tp);
            let mut tv = Transcript::new(b"t");
            let vout = verify(&proof, g, &mut tv).unwrap();
            assert_eq!(vout.point, out.point);
            assert_eq!(vout.p, mle_eval(&p, &out.point));
            assert_eq!(vout.q, mle_eval(&q, &out.point));
            assert_eq!(tp.state(), tv.state());
        }
    }

    #[test]
    fn nonzero_sum_and_tampering_rejected() {
        let (mut p, q) = instance(5, 9);
        p[3] += F::ONE;
        let mut tp = Transcript::new(b"t");
        let (proof, _) = prove(p, q.clone(), &mut tp);
        assert!(verify(&proof, 5, &mut Transcript::new(b"t")).is_err());

        let (p, q) = instance(5, 10);
        let (proof, _) = prove(p, q, &mut Transcript::new(b"t"));
        let mut bad = proof.clone();
        bad.layers[2].rounds[1][0] += F::ONE;
        assert!(verify(&bad, 5, &mut Transcript::new(b"t")).is_err());
        let mut bad = proof.clone();
        bad.layers[3].children[2] += F::ONE;
        // Either the final check fails or the leaf claim changes (caught by the caller).
        match verify(&bad, 5, &mut Transcript::new(b"t")) {
            Err(_) => {}
            Ok(o) => assert_ne!(
                o.q,
                verify(&proof, 5, &mut Transcript::new(b"t")).unwrap().q
            ),
        }
    }
}
