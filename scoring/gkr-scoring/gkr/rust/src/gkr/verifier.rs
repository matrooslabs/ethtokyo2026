//! Sound GKR verifier (upstream shipped none in Rust).
//!
//! Everything the verifier relies on comes from the verifier-side circuit, the public
//! input and the claimed output: the proof only contributes round polynomials and the
//! q_i polynomials. All challenges are recomputed from the transcript.
use super::{
    poly::{eq_index, eval_univariate, l_function, mle_eval},
    prover::{pad_to, start_transcript},
    sumcheck::ROUND_COEFFS,
    transcript::Transcript,
    GKRCircuit, GkrError, Proof,
};
use ff::PrimeField;

/// Evaluates the multilinear extension of a wiring predicate given as gate triples.
fn wiring_eval<S: PrimeField>(
    gates: &[(usize, usize, usize)],
    z: &[S],
    b: &[S],
    c: &[S],
) -> S {
    gates
        .iter()
        .map(|(gz, gb, gc)| eq_index(*gz, z) * eq_index(*gb, b) * eq_index(*gc, c))
        .fold(S::ZERO, |a, x| a + x)
}

/// Verifies that `output` is the result of evaluating `circuit` on `input`.
pub fn verify<S: PrimeField, T: Transcript<S>>(
    circuit: &GKRCircuit<S>,
    input: &[S],
    output: &[S],
    proof: &Proof<S>,
) -> Result<(), GkrError> {
    circuit.validate()?;
    let depth = circuit.depth();
    if proof.sumcheck_proofs.len() != depth || proof.q.len() != depth {
        return Err(GkrError::MalformedProof("wrong number of layers"));
    }
    let input_values = pad_to(input, circuit.k(depth), "input longer than input layer")?;
    let output_values = pad_to(output, circuit.k(0), "output longer than output layer")?;
    if circuit.fixed_inputs.iter().any(|(pos, v)| input_values[*pos] != *v) {
        return Err(GkrError::BadPublicIo("input does not match the circuit's fixed inputs"));
    }
    let mut transcript: T = start_transcript(circuit, &input_values, &output_values)?;

    let mut z = transcript.squeeze_n(circuit.k(0));
    let mut claim = mle_eval(&output_values, &z).ok_or(GkrError::BadPublicIo("output size"))?;

    for i in 0..depth {
        let k_next = circuit.k(i + 1);
        let rounds = &proof.sumcheck_proofs[i];
        if rounds.len() != 2 * k_next {
            return Err(GkrError::MalformedProof("wrong number of sumcheck rounds"));
        }
        let mut r = Vec::with_capacity(2 * k_next);
        for g in rounds {
            if g.len() != ROUND_COEFFS {
                return Err(GkrError::MalformedProof("round polynomial exceeds degree bound"));
            }
            if eval_univariate(g, &S::ZERO) + eval_univariate(g, &S::ONE) != claim {
                return Err(GkrError::Rejected("sumcheck round g(0)+g(1) != claim"));
            }
            transcript.absorb(g);
            let r_j = transcript.squeeze();
            claim = eval_univariate(g, &r_j);
            r.push(r_j);
        }
        let (b_star, c_star) = r.split_at(k_next);

        let q = &proof.q[i];
        if q.len() != k_next + 1 {
            return Err(GkrError::MalformedProof("q exceeds degree bound"));
        }
        let (w_b, w_c) = (eval_univariate(q, &S::ZERO), eval_univariate(q, &S::ONE));
        let (add, mult) = circuit.gates(i);
        let expected = wiring_eval(&add, &z, b_star, c_star) * (w_b + w_c)
            + wiring_eval(&mult, &z, b_star, c_star) * w_b * w_c;
        if expected != claim {
            return Err(GkrError::Rejected("layer relation does not match sumcheck"));
        }
        transcript.absorb(q);
        let r_star = transcript.squeeze();
        claim = eval_univariate(q, &r_star);
        z = l_function(&b_star.to_vec(), &c_star.to_vec(), &r_star);
    }

    let input_eval = mle_eval(&input_values, &z).ok_or(GkrError::BadPublicIo("input size"))?;
    if input_eval != claim {
        return Err(GkrError::Rejected("input layer evaluation mismatch"));
    }
    Ok(())
}
