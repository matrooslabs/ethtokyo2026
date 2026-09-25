use super::{
    poly::*,
    sumcheck::*,
    transcript::{Transcript, DOMAIN_PROOF},
    GKRCircuit, GkrError, Input, Proof,
};
use ff::PrimeField;
use std::vec;

/// Absorbs the statement (circuit digest, public input, public output) into a fresh
/// transcript. Prover and verifier call this identically.
pub fn start_transcript<S: PrimeField, T: Transcript<S>>(
    circuit: &GKRCircuit<S>,
    input_values: &[S],
    output_values: &[S],
) -> Result<T, GkrError> {
    let input = pad_to(input_values, circuit.k(circuit.depth()), "input longer than input layer")?;
    let output = pad_to(output_values, circuit.k(0), "output longer than output layer")?;
    let mut transcript = T::new(DOMAIN_PROOF);
    transcript.absorb(&[circuit.digest::<T>()]);
    transcript.absorb(&input);
    transcript.absorb(&output);
    Ok(transcript)
}

pub(crate) fn pad_to<S: PrimeField>(
    values: &[S],
    k: usize,
    err: &'static str,
) -> Result<Vec<S>, GkrError> {
    let size = 1usize << k;
    if values.len() > size {
        return Err(GkrError::BadPublicIo(err));
    }
    let mut out = values.to_vec();
    out.resize(size, S::ZERO);
    Ok(out)
}

/// Fiat–Shamir GKR prover (upstream algorithm, fixed transcript).
///
/// Schedule: statement (see `start_transcript`) -> z0 (k_0 squeezes) -> for every layer:
/// 2*k_{i+1} round polynomials each absorbed before its challenge -> q_i absorbed -> r*_i.
pub fn prove<S: PrimeField + std::hash::Hash, T: Transcript<S>>(
    circuit: &GKRCircuit<S>,
    input: &Input<S>,
) -> Result<Proof<S>, GkrError> {
    circuit.validate()?;
    if input.w.len() != circuit.depth() + 1 {
        return Err(GkrError::BadPublicIo("witness has the wrong number of layers"));
    }
    let mut transcript: T = start_transcript(circuit, &input.input_values, &input.output_values)?;

    let mut sumcheck_proofs = vec![];
    let mut sumcheck_r = vec![];
    let mut q = vec![];
    let mut r_stars = vec![];
    let mut z = vec![transcript.squeeze_n(circuit.k(0))];

    for i in 0..circuit.depth() {
        let add = circuit.add(i);
        let add_res = if z[i].is_empty() {
            add.clone()
        } else {
            partial_eval_binary_form(&add, &z[i])
        };
        let mult = circuit.mult(i);
        let mult_res = if z[i].is_empty() {
            mult.clone()
        } else {
            partial_eval_binary_form(&mult, &z[i])
        };
        let w_i = input.w(i + 1);
        let mut w_i_ext_b = vec![];
        for t in w_i.iter() {
            w_i_ext_b.push(extend_length(t, 2 * circuit.k(i + 1) + 1));
        }
        let mut w_i_ext_c = modify_poly_from_k(&w_i, circuit.k(i + 1));

        if w_i_ext_b.is_empty() {
            w_i_ext_b = vec![vec![S::ZERO; 2 * circuit.k(i + 1) + 1]];
        }
        if w_i_ext_c.is_empty() {
            w_i_ext_c = vec![vec![S::ZERO; 2 * circuit.k(i + 1) + 1]];
        }

        let (sumcheck_proof, r) = prove_sumcheck_opt(
            &circuit.add_wire(i),
            &circuit.mult_wire(i),
            &add_res,
            &mult_res,
            &w_i_ext_b,
            &w_i_ext_c,
            2 * circuit.k(i + 1),
            &mut transcript,
        )?;
        sumcheck_proofs.push(sumcheck_proof);

        let b_star = r[..circuit.k(i + 1)].to_vec();
        let c_star = r[circuit.k(i + 1)..].to_vec();
        sumcheck_r.push(r);

        // q_i(t) = W_{i+1}(l(t)) has degree <= k_{i+1}.
        let q_i = normalize_coeffs(
            &reduce_multiple_polynomial(&b_star, &c_star, &w_i),
            circuit.k(i + 1) + 1,
        )?;
        transcript.absorb(&q_i);
        q.push(q_i);

        let r_star = transcript.squeeze();
        z.push(l_function(&b_star, &c_star, &r_star));
        r_stars.push(r_star);
    }

    Ok(Proof {
        sumcheck_proofs,
        sumcheck_r,
        d: input.d.clone(),
        q,
        z,
        r: r_stars,
        depth: circuit.depth() + 1,
        input_func: input.w(circuit.depth()),
        k: circuit.get_k_list(),
    })
}
