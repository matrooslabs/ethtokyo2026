//! Completeness and soundness regression tests for the fixed prover/verifier.
use ff::Field;
use gkr::gkr::{
    builder::{Gate, LayeredCircuit},
    poly::mle_eval,
    prover::prove,
    transcript::MimcTranscript,
    verifier::verify,
    GkrError, Proof,
};
use halo2curves::bn256::Fr;

type T = MimcTranscript;

fn fr(x: u64) -> Fr {
    Fr::from(x)
}

/// Binary tree reducing 2^n inputs with alternating mult/add layers.
fn tree(n: usize) -> LayeredCircuit {
    let mut layers = vec![];
    for level in 0..n {
        let width = 1 << level;
        layers.push(
            (0..width)
                .map(|g| if level % 2 == 0 { Gate::Mult(2 * g, 2 * g + 1) } else { Gate::Add(2 * g, 2 * g + 1) })
                .collect(),
        );
    }
    LayeredCircuit { layers, input_size: 1 << n }
}

/// Upstream's python example: (3*3 * 2*2, 2*3 * 1*1) with shared operands.
fn shared_operands() -> LayeredCircuit {
    LayeredCircuit {
        layers: vec![
            vec![Gate::Mult(0, 1), Gate::Mult(2, 3)],
            vec![Gate::Mult(0, 0), Gate::Mult(1, 1), Gate::Mult(1, 2), Gate::Mult(3, 3)],
        ],
        input_size: 4,
    }
}

/// Several outputs, mixed gates, and a padded (non power-of-two) layer.
fn mixed() -> LayeredCircuit {
    LayeredCircuit {
        layers: vec![
            vec![Gate::Add(0, 1), Gate::Mult(1, 2), Gate::Add(2, 2)],
            vec![Gate::Mult(0, 3), Gate::Add(1, 2), Gate::Mult(4, 5), Gate::Add(6, 7), Gate::Mult(0, 7)],
        ],
        input_size: 8,
    }
}

fn inputs(n: usize) -> Vec<Fr> {
    (0..n).map(|i| fr(3 + 7 * i as u64)).collect()
}

fn setup(c: &LayeredCircuit) -> (gkr::gkr::GKRCircuit<Fr>, Vec<Fr>, Vec<Fr>, Proof<Fr>) {
    let circuit = c.to_gkr::<Fr>();
    let input = inputs(c.input_size);
    let witness = c.witness(&input);
    let output = witness.output_values.clone();
    let proof = prove::<Fr, T>(&circuit, &witness).expect("honest proving");
    (circuit, input, output, proof)
}

fn cases() -> Vec<LayeredCircuit> {
    vec![tree(2), tree(3), tree(5), shared_operands(), mixed()]
}

#[test]
fn honest_proofs_verify() {
    for c in cases() {
        let (circuit, input, output, proof) = setup(&c);
        assert_eq!(verify::<Fr, T>(&circuit, &input, &output, &proof), Ok(()));
    }
}

#[test]
fn wrong_output_rejected_including_non_first_gates() {
    // Upstream fixed z0 = 0, so only output gate 0 was ever checked.
    let (circuit, input, output, proof) = setup(&mixed());
    let mut forged = output.clone();
    forged[1] += Fr::ONE;
    let zeros = vec![Fr::ZERO; circuit.k(0)];
    assert_eq!(mle_eval(&output, &zeros), mle_eval(&forged, &zeros), "z0 = 0 cannot see gate 1");
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &forged, &proof), Err(GkrError::Rejected(_))));
    for i in 0..output.len() {
        let mut forged = output.clone();
        forged[i] += Fr::ONE;
        assert!(verify::<Fr, T>(&circuit, &input, &forged, &proof).is_err(), "output gate {i}");
    }
}

#[test]
fn proof_bound_to_input_output_and_circuit() {
    let (circuit, input, output, proof) = setup(&tree(3));
    let mut other_input = input.clone();
    other_input[5] += Fr::ONE;
    assert!(verify::<Fr, T>(&circuit, &other_input, &output, &proof).is_err());
    // Same shape, different wiring (Add instead of Mult at the root): the digest differs.
    let mut c2 = tree(3);
    c2.layers[0][0] = Gate::Add(0, 1);
    let circuit2 = c2.to_gkr::<Fr>();
    assert!(verify::<Fr, T>(&circuit2, &input, &output, &proof).is_err());
    // A correct proof for the other circuit still verifies against that circuit only.
    let w2 = c2.witness(&input);
    let p2 = prove::<Fr, T>(&circuit2, &w2).unwrap();
    assert_eq!(verify::<Fr, T>(&circuit2, &input, &w2.output_values, &p2), Ok(()));
    assert!(verify::<Fr, T>(&circuit, &input, &w2.output_values, &p2).is_err());
}

#[test]
fn tampered_messages_rejected() {
    let (circuit, input, output, proof) = setup(&mixed());
    for layer in 0..proof.sumcheck_proofs.len() {
        for round in 0..proof.sumcheck_proofs[layer].len() {
            for coeff in 0..3 {
                let mut p = proof.clone();
                p.sumcheck_proofs[layer][round][coeff] += Fr::ONE;
                assert!(verify::<Fr, T>(&circuit, &input, &output, &p).is_err());
            }
        }
        for coeff in 0..proof.q[layer].len() {
            let mut p = proof.clone();
            p.q[layer][coeff] += Fr::ONE;
            assert!(verify::<Fr, T>(&circuit, &input, &output, &p).is_err());
        }
    }
}

#[test]
fn consistent_round_forgery_rejected() {
    // Keep g(0)+g(1) = claim in round 0 while changing g: passes the local check but the
    // re-derived challenge and final layer check must reject it.
    let (circuit, input, output, proof) = setup(&tree(3));
    let mut p = proof.clone();
    let g = &mut p.sumcheck_proofs[0][0];
    // g(X) = a X^2 + b X + c: adding (2X - 1) keeps g(0) + g(1) unchanged.
    g[1] += Fr::from(2);
    g[2] -= Fr::ONE;
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &output, &p), Err(GkrError::Rejected(_))));
}

#[test]
fn degree_and_shape_bounds_enforced() {
    let (circuit, input, output, proof) = setup(&tree(3));
    let mut p = proof.clone();
    p.sumcheck_proofs[0][0].insert(0, Fr::ZERO); // 4 coefficients, even if leading is zero
    assert_eq!(
        verify::<Fr, T>(&circuit, &input, &output, &p),
        Err(GkrError::MalformedProof("round polynomial exceeds degree bound"))
    );
    let mut p = proof.clone();
    p.q[1].insert(0, Fr::ZERO);
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &output, &p), Err(GkrError::MalformedProof(_))));
    let mut p = proof.clone();
    p.sumcheck_proofs[1].pop();
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &output, &p), Err(GkrError::MalformedProof(_))));
    let mut p = proof.clone();
    p.sumcheck_proofs.pop();
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &output, &p), Err(GkrError::MalformedProof(_))));
}

#[test]
fn malformed_proofs_do_not_panic() {
    let (circuit, input, output, proof) = setup(&tree(3));
    let mut shapes = vec![];
    let mut p = proof.clone();
    p.sumcheck_proofs = vec![vec![]; 3];
    shapes.push(p);
    let mut p = proof.clone();
    p.q = vec![vec![]; 3];
    shapes.push(p);
    let mut p = proof.clone();
    p.sumcheck_proofs[2] = vec![vec![]; 6];
    shapes.push(p);
    for p in shapes {
        assert!(verify::<Fr, T>(&circuit, &input, &output, &p).is_err());
    }
    let too_long = vec![Fr::ONE; 1 + (1 << circuit.k(0))];
    assert!(matches!(verify::<Fr, T>(&circuit, &input, &too_long, &proof), Err(GkrError::BadPublicIo(_))));
}

#[test]
fn prover_hints_are_ignored() {
    // z, r, sumcheck_r, k, depth, d and input_func are not trusted by the verifier.
    let (circuit, input, output, mut proof) = setup(&mixed());
    for z in proof.z.iter_mut() {
        for x in z.iter_mut() {
            *x = Fr::ZERO;
        }
    }
    proof.r = vec![Fr::ONE; proof.r.len()];
    proof.sumcheck_r = vec![];
    proof.k = vec![0; 1];
    proof.depth = 99;
    proof.d = vec![];
    proof.input_func = vec![];
    assert_eq!(verify::<Fr, T>(&circuit, &input, &output, &proof), Ok(()));
}

#[test]
fn unsupported_circuits_error_instead_of_panicking() {
    let c = LayeredCircuit { layers: vec![vec![Gate::Add(0, 0)]], input_size: 1 };
    let circuit = c.to_gkr::<Fr>();
    let w = c.witness(&[fr(1)]);
    assert!(matches!(prove::<Fr, T>(&circuit, &w), Err(GkrError::UnsupportedCircuit(_))));
}

/// Same circuit and input as python/test_security.py::example_circuit. The python and rust
/// implementations share the transcript, so digest and proof must be identical.
#[test]
fn python_example_matches_rust() {
    let c = shared_operands();
    let circuit = c.to_gkr::<Fr>();
    let input = [fr(3), fr(2), fr(3), fr(1)];
    let w = c.witness(&input);
    assert_eq!(w.output_values, vec![fr(36), fr(6)]);
    let digest = circuit.digest::<T>();
    let proof = prove::<Fr, T>(&circuit, &w).unwrap();
    assert_eq!(
        format!("{:?}", digest),
        "0x23983e6d2fe8b6457bfccb6e299cbfc9b07350b8bb0f798846302b3b46afc5dd"
    );
    assert_eq!(
        format!("{:?}", proof.q[0][2]),
        "0x2d4265f26e493d73621ca6b170fbf3c86f0621ac6259d87730fc4484f8e2744c"
    );
    assert_eq!(verify::<Fr, T>(&circuit, &input, &w.output_values, &proof), Ok(()));
}

#[test]
fn fixed_inputs_are_pinned_and_part_of_the_digest() {
    let c = mixed();
    let input = inputs(c.input_size);
    let circuit = c.to_gkr::<Fr>().with_fixed_inputs(vec![(1, input[1]), (6, input[6])]);
    let w = c.witness(&input);
    let proof = prove::<Fr, T>(&circuit, &w).unwrap();
    assert_eq!(verify::<Fr, T>(&circuit, &input, &w.output_values, &proof), Ok(()));
    // an honest proof for a modified constant is rejected by the circuit that pins it
    let mut other = input.clone();
    other[6] += Fr::ONE;
    let w2 = c.witness(&other);
    let p2 = prove::<Fr, T>(&c.to_gkr::<Fr>(), &w2).unwrap();
    assert!(matches!(
        verify::<Fr, T>(&circuit, &other, &w2.output_values, &p2),
        Err(GkrError::BadPublicIo(_))
    ));
    // same wiring without the pins has a different digest
    assert_ne!(circuit.digest::<T>(), c.to_gkr::<Fr>().digest::<T>());
}
