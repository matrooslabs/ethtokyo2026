use std::vec;

use ff::PrimeField;
use itertools::Itertools;
use rayon::prelude::{IntoParallelRefIterator, ParallelIterator};

use super::poly::*;
use super::transcript::Transcript;
use super::GkrError;

/// Round polynomials are sent with exactly `ROUND_COEFFS` coefficients (highest degree
/// first): the GKR sumcheck polynomial add*(W(b)+W(c)) + mult*W(b)*W(c) has degree <= 2 in
/// every variable.
pub const ROUND_COEFFS: usize = 3;

/// Left-pads a highest-degree-first coefficient vector to exactly `len` coefficients.
pub fn normalize_coeffs<S: PrimeField>(coeffs: &[S], len: usize) -> Result<Vec<S>, GkrError> {
    let first_nonzero = coeffs.iter().position(|c| *c != S::ZERO).unwrap_or(coeffs.len());
    let trimmed = &coeffs[first_nonzero..];
    if trimmed.len() > len {
        return Err(GkrError::UnsupportedCircuit("round polynomial exceeds degree bound"));
    }
    let mut out = vec![S::ZERO; len - trimmed.len()];
    out.extend_from_slice(trimmed);
    Ok(out)
}

fn n_trailing_bits<S: PrimeField + std::hash::Hash>(
    wire: &Vec<Vec<S>>,
    n: usize,
) -> Vec<Vec<S>> {
    let mut res: Vec<Vec<S>> = wire
        .iter()
        .map(|inner_vec| inner_vec.iter().rev().take(n).rev().cloned().collect())
        .collect();
    res.into_iter().unique().collect()
}

// only can be run for f: add_i(f1 + f2) + mult_i(f1 * f2)
///
/// Every round polynomial is normalized to `ROUND_COEFFS` coefficients, absorbed into the
/// running transcript, and the round challenge is squeezed from that transcript.
pub fn prove_sumcheck_opt<S: PrimeField + std::hash::Hash, T: Transcript<S>>(
    add_wire: &Vec<Vec<S>>,
    mult_wire: &Vec<Vec<S>>,
    add_i: &Vec<Vec<S>>,
    mult_i: &Vec<Vec<S>>,
    f1: &Vec<Vec<S>>,
    f2: &Vec<Vec<S>>,
    v: usize,
    transcript: &mut T,
) -> Result<(Vec<Vec<S>>, Vec<S>), GkrError> {
    if v < 2 {
        return Err(GkrError::UnsupportedCircuit("sumcheck needs at least two variables"));
    }
    let mut proof = vec![];
    let mut r = vec![];

    let add_assignments: Vec<Vec<S>> = n_trailing_bits(add_wire, v - 1);
    let g_1_add = add_assignments
        .par_iter()
        .map(|assignment| {
            let f2_1_sub = partial_eval_from(f2, assignment, 2);
            let f1_1_sub = partial_eval_from(f1, assignment, 2);
            let add_1_sub = partial_eval_from_binary_form(&add_i.clone(), assignment, 2);

            let f1_1_coeffs = get_univariate_coeff(&f1_1_sub, 1, false);
            let f2_1_coeffs = get_univariate_coeff(&f2_1_sub, 1, false);
            let add_1_coeffs = get_univariate_coeff(&add_1_sub, 1, true);
            let f1_f2_add = add_univariate(&f1_1_coeffs, &f2_1_coeffs);
            mult_univariate(&f1_f2_add, &add_1_coeffs)
        })
        .reduce(|| vec![], |a, b| add_univariate(&a, &b));
    let mult_assignments: Vec<Vec<S>> = n_trailing_bits(mult_wire, v - 1);
    let g_1_mult = mult_assignments
        .par_iter()
        .map(|assignment| {
            let f2_1_sub = partial_eval_from(f2, assignment, 2);
            let f1_1_sub = partial_eval_from(f1, assignment, 2);
            let mult_1_sub = partial_eval_from_binary_form(&mult_i.clone(), assignment, 2);

            let f1_1_coeffs = get_univariate_coeff(&f1_1_sub, 1, false);
            let f2_1_coeffs = get_univariate_coeff(&f2_1_sub, 1, false);
            let mult_1_coeffs = get_univariate_coeff(&mult_1_sub, 1, true);
            let f1_f2_mult = mult_univariate(&f1_1_coeffs, &f2_1_coeffs);
            mult_univariate(&f1_f2_mult, &mult_1_coeffs)
        })
        .reduce(|| vec![], |a, b| add_univariate(&a, &b));

    let g_1 = normalize_coeffs(&add_univariate(&g_1_add, &g_1_mult), ROUND_COEFFS)?;
    transcript.absorb(&g_1);
    proof.push(g_1);
    r.push(transcript.squeeze());
    let mut f1_j = f1.clone();
    let mut f2_j = f2.clone();
    let mut add_j = add_i.clone();
    let mut mult_j = mult_i.clone();
    for j in 1..v - 1 {
        f1_j = partial_eval_i(&f1_j, &r[r.len() - 1], r.len());
        f2_j = partial_eval_i(&f2_j, &r[r.len() - 1], r.len());
        add_j = partial_eval_i_binary_form(&add_j, &r[r.len() - 1], r.len());
        mult_j = partial_eval_i_binary_form(&mult_j, &r[r.len() - 1], r.len());
        let add_assignments: Vec<Vec<S>> = n_trailing_bits(add_wire, v - j - 1);
        let mult_assignments: Vec<Vec<S>> = n_trailing_bits(mult_wire, v - j - 1);
        let g_j_add = add_assignments
            .par_iter()
            .map(|assignment| {
                let f1_j_sub = partial_eval_from(&f1_j, assignment, j + 2);
                let f2_j_sub = partial_eval_from(&f2_j, assignment, j + 2);
                let add_j_sub = partial_eval_from_binary_form(&add_j.clone(), assignment, j + 2);

                let f1_j_coeffs = get_univariate_coeff(&f1_j_sub, j + 1, false);
                let f2_j_coeffs = get_univariate_coeff(&f2_j_sub, j + 1, false);
                let add_j_coeffs = get_univariate_coeff(&add_j_sub, j + 1, true);
                let f1_f2_add = add_univariate(&f1_j_coeffs, &f2_j_coeffs);
                mult_univariate(&f1_f2_add, &add_j_coeffs)
            })
            .reduce(|| vec![], |a, b| add_univariate(&a, &b));
        let g_j_mult = mult_assignments
            .par_iter()
            .map(|assignment| {
                let f1_j_sub = partial_eval_from(&f1_j, assignment, j + 2);
                let f2_j_sub = partial_eval_from(&f2_j, assignment, j + 2);
                let mult_j_sub = partial_eval_from_binary_form(&mult_j.clone(), assignment, j + 2);

                let f1_j_coeffs = get_univariate_coeff(&f1_j_sub, j + 1, false);
                let f2_j_coeffs = get_univariate_coeff(&f2_j_sub, j + 1, false);
                let mult_j_coeffs = get_univariate_coeff(&mult_j_sub, j + 1, true);
                let f1_f2_mult = mult_univariate(&f1_j_coeffs, &f2_j_coeffs);
                mult_univariate(&f1_f2_mult, &mult_j_coeffs)
            })
            .reduce(|| vec![], |a, b| add_univariate(&a, &b));
        let g_j = normalize_coeffs(&add_univariate(&g_j_add, &g_j_mult), ROUND_COEFFS)?;
        transcript.absorb(&g_j);
        proof.push(g_j);
        r.push(transcript.squeeze());
    }
    let mut f1_v = f1.clone();
    let mut f2_v = f2.clone();
    let mut add_v = add_i.clone();
    let mut mult_v = mult_i.clone();
    f1_v = partial_eval(&f1_v, &r);
    f2_v = partial_eval(&f2_v, &r);
    add_v = partial_eval_binary_form(&add_v, &r);
    mult_v = partial_eval_binary_form(&mult_v, &r);

    let f1_v_coeffs = get_univariate_coeff(&f1_v, 1, false);
    let f2_v_coeffs = get_univariate_coeff(&f2_v, 1, false);
    let add_v_coeffs = get_univariate_coeff(&add_v, 1, true);
    let mult_v_coeffs = get_univariate_coeff(&mult_v, 1, true);
    let f1_f2_add = add_univariate(&f1_v_coeffs, &f2_v_coeffs);
    let f1_f2_mult = mult_univariate(&f1_v_coeffs, &f2_v_coeffs);
    let add = mult_univariate(&f1_f2_add, &add_v_coeffs);
    let mult = mult_univariate(&f1_f2_mult, &mult_v_coeffs);
    let f = normalize_coeffs(&add_univariate(&add, &mult), ROUND_COEFFS)?;
    transcript.absorb(&f);
    proof.push(f);
    r.push(transcript.squeeze());

    Ok((proof, r))
}

/// Generic (unoptimized) sumcheck prover for a polynomial in monomial form. Round
/// polynomials are absorbed into `transcript` and challenges squeezed from it.
pub fn prove_sumcheck<S: PrimeField + std::hash::Hash, T: Transcript<S>>(
    g: &Vec<Vec<S>>,
    v: usize,
    transcript: &mut T,
) -> (Vec<Vec<S>>, Vec<S>) {
    let mut proof = vec![];
    let mut r = vec![];

    let mut g_1 = get_empty(v);
    let assignments: Vec<Vec<S>> = generate_binary(v - 1);
    for assignment in assignments {
        let mut g_1_sub = g.clone();
        for (i, x_i) in assignment.into_iter().enumerate() {
            let idx = i + 2;
            g_1_sub = partial_eval_i(&g_1_sub, &x_i, idx);
        }
        g_1 = add_poly(&g_1, &g_1_sub);
    }
    let g_1_coeffs = get_univariate_coeff(&g_1, 1, false);
    transcript.absorb(&g_1_coeffs);
    proof.push(g_1_coeffs);
    r.push(transcript.squeeze());

    for j in 1..v - 1 {
        let mut g_j: Vec<Vec<S>> = g.clone();
        let assignments: Vec<Vec<S>> = generate_binary(v - j - 1);

        for (i, r_i) in r.iter().enumerate() {
            g_j = partial_eval_i(&g_j, r_i, i + 1);
        }
        let mut res_g_j = get_empty(v);
        for assignment in assignments {
            let mut g_j_sub = g_j.clone();
            for (i, x_i) in assignment.into_iter().enumerate() {
                let idx = j + i + 2;
                g_j_sub = partial_eval_i(&g_j_sub, &x_i, idx);
            }
            res_g_j = add_poly(&res_g_j, &g_j_sub);
        }
        let g_j_coeffs = get_univariate_coeff(&res_g_j, j + 1, false);
        transcript.absorb(&g_j_coeffs);
        proof.push(g_j_coeffs);
        r.push(transcript.squeeze());
    }
    let g_v = partial_eval(&g, &r);
    let g_v_coeffs = get_univariate_coeff(&g_v, 1, false);
    transcript.absorb(&g_v_coeffs);
    proof.push(g_v_coeffs);
    r.push(transcript.squeeze());

    (proof, r)
}
