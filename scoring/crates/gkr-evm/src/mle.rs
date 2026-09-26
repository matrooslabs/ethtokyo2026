//! Dense multilinear extensions, little-endian variable order (x_0 = index bit 0).
use crate::field::{Field, F};
use rayon::prelude::*;

pub fn eq1(a: F, b: F) -> F {
    a * b + (F::ONE - a) * (F::ONE - b)
}

pub fn eq_eval(a: &[F], b: &[F]) -> F {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(&x, &y)| eq1(x, y)).product()
}

/// eq(bits(c), x) for an integer c over the given variables.
pub fn eq_const(c: u64, x: &[F]) -> F {
    x.iter()
        .enumerate()
        .map(|(j, &xj)| if (c >> j) & 1 == 1 { xj } else { F::ONE - xj })
        .product()
}

/// Table T[i] = eq(bits(i), point) for i < 2^k.
pub fn eq_table(point: &[F]) -> Vec<F> {
    let mut table = vec![F::ONE];
    // Build from the highest variable so that bit j of the index matches point[j].
    for &p in point.iter().rev() {
        let mut next = vec![F::ZERO; table.len() * 2];
        next.par_chunks_mut(2)
            .zip(table.par_iter())
            .for_each(|(pair, &t)| {
                let hi = t * p;
                pair[1] = hi;
                pair[0] = t - hi;
            });
        table = next;
    }
    table
}

/// Evaluates the MLE of `values` (length 2^k, or shorter: zero-padded) at `point`.
pub fn mle_eval(values: &[F], point: &[F]) -> F {
    assert!(values.len() <= 1usize << point.len());
    let eq = eq_table(point);
    values
        .par_iter()
        .zip(eq.par_iter())
        .map(|(v, e)| *v * e)
        .sum()
}

/// Binds the lowest variable: v'[i] = v[2i] + r·(v[2i+1] − v[2i]).
pub fn fold(values: &[F], r: F) -> Vec<F> {
    assert!(values.len().is_multiple_of(2));
    values
        .par_chunks(2)
        .map(|pair| pair[0] + r * (pair[1] - pair[0]))
        .collect()
}

/// Π_{j ≥ from} (1 − x_j): MLE factor of zero-padding in high variables.
pub fn pad_factor(point: &[F], from: usize) -> F {
    point[from.min(point.len())..]
        .iter()
        .map(|&x| F::ONE - x)
        .product()
}

/// MLE of the identity vector i ↦ i.
pub fn id_mle(point: &[F]) -> F {
    let mut acc = F::ZERO;
    let mut pow = F::ONE;
    for &x in point {
        acc += pow * x;
        pow = pow.double();
    }
    acc
}

/// MLE of i ↦ [i < n] over k = point.len() variables (requires n ≤ 2^k).
pub fn step_mle(n: u64, point: &[F]) -> F {
    let k = point.len();
    if k < 64 && n >= (1u64 << k) {
        return F::ONE;
    }
    let mut acc = F::ZERO;
    let mut prefix = F::ONE; // Π_{i>j} eq(x_i, n_i)
    for j in (0..k).rev() {
        let bit = (n >> j) & 1;
        if bit == 1 {
            acc += prefix * (F::ONE - point[j]);
            prefix *= point[j];
        } else {
            prefix *= F::ONE - point[j];
        }
    }
    acc
}

pub fn log2_ceil(n: usize) -> usize {
    if n <= 1 {
        0
    } else {
        (usize::BITS - (n - 1).leading_zeros()) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rand_point(k: usize, seed: u64) -> Vec<F> {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);
        (0..k).map(|_| F::random(&mut rng)).collect()
    }

    fn bits(i: usize, k: usize) -> Vec<F> {
        (0..k).map(|j| F::from(((i >> j) & 1) as u64)).collect()
    }

    #[test]
    fn eq_table_matches_definition() {
        let p = rand_point(4, 1);
        let t = eq_table(&p);
        for (i, ti) in t.iter().enumerate() {
            assert_eq!(*ti, eq_eval(&bits(i, 4), &p));
            assert_eq!(*ti, eq_const(i as u64, &p));
        }
    }

    #[test]
    fn fold_equals_eval() {
        let v: Vec<F> = (0..16).map(|i| F::from(i * i + 3)).collect();
        let p = rand_point(4, 2);
        let mut cur = v.clone();
        for &x in &p {
            cur = fold(&cur, x);
        }
        assert_eq!(cur[0], mle_eval(&v, &p));
    }

    #[test]
    fn public_mles() {
        let k = 5;
        let p = rand_point(k, 3);
        let ids: Vec<F> = (0..32).map(|i| F::from(i as u64)).collect();
        assert_eq!(id_mle(&p), mle_eval(&ids, &p));
        for n in [0u64, 1, 5, 17, 31, 32] {
            let step: Vec<F> = (0..32).map(|i| F::from((i < n) as u64)).collect();
            assert_eq!(step_mle(n, &p), mle_eval(&step, &p), "n={n}");
        }
        let short: Vec<F> = (0..4).map(|i| F::from(i + 1)).collect();
        assert_eq!(
            mle_eval(&short, &p),
            mle_eval(&short, &p[..2]) * pad_factor(&p, 2)
        );
        assert_eq!(log2_ceil(1), 0);
        assert_eq!(log2_ceil(5), 3);
        assert_eq!(log2_ceil(8), 3);
    }
}
