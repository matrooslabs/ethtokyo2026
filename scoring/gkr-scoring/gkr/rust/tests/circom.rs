//! Compiles generated circom verifiers and runs witness generation for honest and forged
//! proofs. Needs circom, node and circomlib (npm install in gkr-verifier-circuits/circom):
//!   GKR_CIRCOM=/path/to/circom cargo test --release --test circom -- --nocapture
//! Without GKR_CIRCOM the test is skipped (and says so).
use ff::Field;
use gkr::{
    circom_codegen::{gkr_verifier_inputs, gkr_verifier_template},
    gkr::{
        builder::{Gate, LayeredCircuit},
        prover::prove,
        transcript::MimcTranscript,
        GKRCircuit, Proof,
    },
};
use halo2curves::bn256::Fr;
use std::{path::PathBuf, process::Command};

fn lib_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../gkr-verifier-circuits/circom/circom/verifier.circom")
        .canonicalize()
        .expect("verifier.circom")
}

struct Case {
    circuit: GKRCircuit<Fr>,
    input: Vec<Fr>,
    output: Vec<Fr>,
    proof: Proof<Fr>,
}

fn case(c: &LayeredCircuit, fixed: &[usize]) -> Case {
    let input: Vec<Fr> = (0..c.input_size).map(|i| Fr::from(5 + 3 * i as u64)).collect();
    let circuit = c
        .to_gkr::<Fr>()
        .with_fixed_inputs(fixed.iter().map(|p| (*p, input[*p])).collect());
    let witness = c.witness(&input);
    let proof = prove::<Fr, MimcTranscript>(&circuit, &witness).unwrap();
    Case { circuit, input, output: witness.output_values, proof }
}

fn inputs_json(c: &Case, input: &[Fr], proof: &Proof<Fr>) -> String {
    let v = gkr_verifier_inputs(&c.circuit, input, proof).unwrap();
    let mut fields = vec![format!("\"inputValues\": {}", v.input_values)];
    for (i, r) in v.rounds.iter().enumerate() {
        fields.push(format!("\"rounds{i}\": {r}"));
    }
    for (i, q) in v.q.iter().enumerate() {
        fields.push(format!("\"q{i}\": {q}"));
    }
    format!("{{{}}}", fields.join(",\n"))
}

/// Compiles `template` and returns a closure that runs witness generation on a JSON input.
fn compile(circom: &str, dir: &PathBuf, name: &str, template: &str) -> impl Fn(&str) -> bool {
    std::fs::create_dir_all(dir).unwrap();
    let src = format!(
        "pragma circom 2.0.4;\ninclude \"{}\";\n{}\ncomponent main = {name}();\n",
        lib_path().display(),
        template
    );
    let file = dir.join(format!("{name}.circom"));
    std::fs::write(&file, src).unwrap();
    let out = Command::new(circom)
        .arg(&file)
        .args(["--r1cs", "--wasm", "-o"])
        .arg(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "circom failed: {}", String::from_utf8_lossy(&out.stderr));
    let js = dir.join(format!("{name}_js"));
    let dir = dir.clone();
    let name = name.to_string();
    move |json: &str| {
        let input = dir.join("input.json");
        std::fs::write(&input, json).unwrap();
        Command::new("node")
            .arg(js.join("generate_witness.js"))
            .arg(js.join(format!("{name}.wasm")))
            .arg(&input)
            .arg(dir.join("witness.wtns"))
            .output()
            .unwrap()
            .status
            .success()
    }
}

#[test]
fn generated_circom_verifier_accepts_honest_and_rejects_forged() {
    let Ok(circom) = std::env::var("GKR_CIRCOM") else {
        eprintln!("SKIPPED: set GKR_CIRCOM to a circom binary to run this test");
        return;
    };
    let tmp = std::env::temp_dir().join(format!("gkr-circom-test-{}", std::process::id()));
    let circuits = [
        (
            "Mixed",
            LayeredCircuit {
                layers: vec![
                    vec![Gate::Add(0, 1), Gate::Mult(1, 2), Gate::Add(2, 2)],
                    vec![Gate::Mult(0, 3), Gate::Add(1, 2), Gate::Mult(4, 5), Gate::Add(6, 7), Gate::Mult(0, 7)],
                ],
                input_size: 8,
            },
            vec![1usize, 6],
        ),
        (
            "SingleOutput",
            LayeredCircuit {
                layers: vec![vec![Gate::Mult(0, 1)], vec![Gate::Add(0, 1), Gate::Mult(2, 3)]],
                input_size: 4,
            },
            vec![],
        ),
    ];
    for (name, lc, fixed) in circuits {
        let c = case(&lc, &fixed);
        let template = gkr_verifier_template(&c.circuit, &c.output, name).unwrap();
        let run = compile(&circom, &tmp.join(name), name, &template);
        assert!(run(&inputs_json(&c, &c.input, &c.proof)), "{name}: honest proof rejected");

        // every coefficient of every message
        for layer in 0..c.proof.sumcheck_proofs.len() {
            for round in 0..c.proof.sumcheck_proofs[layer].len() {
                let mut p = c.proof.clone();
                p.sumcheck_proofs[layer][round][0] += Fr::ONE;
                assert!(!run(&inputs_json(&c, &c.input, &p)), "{name}: forged round accepted");
            }
            let mut p = c.proof.clone();
            p.q[layer][0] += Fr::ONE;
            assert!(!run(&inputs_json(&c, &c.input, &p)), "{name}: forged q accepted");
        }
        // round polynomial changed while keeping g(0) + g(1)
        let mut p = c.proof.clone();
        p.sumcheck_proofs[0][0][1] += Fr::from(2);
        p.sumcheck_proofs[0][0][2] -= Fr::ONE;
        assert!(!run(&inputs_json(&c, &c.input, &p)), "{name}: consistent forgery accepted");
        // a different input (witness) with the same proof
        let mut input = c.input.clone();
        input[3] += Fr::ONE;
        assert!(!run(&inputs_json(&c, &input, &c.proof)), "{name}: wrong input accepted");
        // a fixed (constant) input position changed together with an honest proof for it
        if let Some(pos) = fixed.first() {
            let mut input = c.input.clone();
            input[*pos] += Fr::ONE;
            let w = lc.witness(&input);
            let other = lc.to_gkr::<Fr>().with_fixed_inputs(c.circuit.fixed_inputs.clone());
            let p = prove::<Fr, MimcTranscript>(&other, &w).unwrap();
            assert!(!run(&inputs_json(&c, &input, &p)), "{name}: modified constant accepted");
        }
        // a verifier compiled for a false output rejects the honest proof
        let mut false_out = c.output.clone();
        let last = false_out.len() - 1;
        false_out[last] += Fr::ONE;
        let forged_name = format!("{name}FalseOutput");
        let template = gkr_verifier_template(&c.circuit, &false_out, &forged_name).unwrap();
        let run_false = compile(&circom, &tmp.join(&forged_name), &forged_name, &template);
        assert!(!run_false(&inputs_json(&c, &c.input, &c.proof)), "{name}: false output accepted");
        eprintln!("{name}: honest accepted, all forgeries rejected");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
