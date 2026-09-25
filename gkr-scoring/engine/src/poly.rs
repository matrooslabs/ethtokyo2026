//! Univariate round polynomials given by evaluations at 0..=d.
use crate::field::{Field, F};

/// Lagrange interpolation of evals at 0..=d evaluated at r, without runtime inversions
/// of r-dependent values (denominators are constants), as in Solidity.
pub fn interpolate(evals: &[F], r: F) -> F {
    let d = evals.len() - 1;
    // If r is one of the nodes, return directly (numerator products would vanish).
    for (i, e) in evals.iter().enumerate() {
        if r == F::from(i as u64) {
            return *e;
        }
    }
    let mut prefix = vec![F::ONE; d + 2];
    for j in 0..=d {
        prefix[j + 1] = prefix[j] * (r - F::from(j as u64));
    }
    let mut suffix = vec![F::ONE; d + 2];
    for j in (0..=d).rev() {
        suffix[j] = suffix[j + 1] * (r - F::from(j as u64));
    }
    let mut acc = F::ZERO;
    for i in 0..=d {
        let num = prefix[i] * suffix[i + 1];
        acc += evals[i] * num * lagrange_denominator_inv(i, d);
    }
    acc
}

/// 1 / Π_{j≠i} (i − j) over nodes 0..=d.
pub fn lagrange_denominator_inv(i: usize, d: usize) -> F {
    let mut den = F::ONE;
    for j in 0..=d {
        if j != i {
            den *= F::from(i as u64) - F::from(j as u64);
        }
    }
    den.invert().unwrap()
}

/// Reconstructs all d+1 evaluations from the compressed message [g(0), g(2), …, g(d)]
/// using g(1) = claim − g(0).
pub fn decompress(claim: F, sent: &[F]) -> Vec<F> {
    let mut evals = Vec::with_capacity(sent.len() + 1);
    evals.push(sent[0]);
    evals.push(claim - sent[0]);
    evals.extend_from_slice(&sent[1..]);
    evals
}

pub fn compress(evals: &[F]) -> Vec<F> {
    let mut out = vec![evals[0]];
    out.extend_from_slice(&evals[2..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_recovers_cubic() {
        let f = |x: F| x * x * x * F::from(3) + x * F::from(5) + F::from(7);
        let evals: Vec<F> = (0..4).map(|i| f(F::from(i))).collect();
        for r in [F::from(9), F::from(123456), -F::from(4), F::from(2)] {
            assert_eq!(interpolate(&evals, r), f(r));
        }
        let claim = evals[0] + evals[1];
        assert_eq!(decompress(claim, &compress(&evals)), evals);
    }
}
