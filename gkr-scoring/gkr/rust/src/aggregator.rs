use std::{env::current_dir, fs::File, time::Instant};

use crate::{
    circom_codegen::{gkr_verifier_inputs, gkr_verifier_template},
    convert::convert_r1cs_wtns_gkr,
    file_utils::{execute_circom, get_name, write_aggregated_input, write_output},
    gkr::{prover, transcript::MimcTranscript, verifier, GKRCircuit, Input, Proof},
};
use colored::Colorize;
use halo2curves::bn256::Fr;
use r1cs_file::*;
use serde_json::Value;
use wtns_file::*;

use rayon::prelude::*;

/// A GKR proof together with the (verifier-side) circuit it is about and the input-layer
/// witness the aggregated circom circuit needs. Upstream passed only proofs and a `meta`
/// shape vector between rounds and let the circom verifier take everything else from
/// the prover.
pub struct GkrArtifact {
    pub circuit: GKRCircuit<Fr>,
    pub input_values: Vec<Fr>,
    pub output_values: Vec<Fr>,
    pub proof: Proof<Fr>,
}

/// Converts a compiled circom circuit + witness to GKR circuits and proves them. Each proof
/// is checked with the sound verifier before being handed to the next round.
fn prove_r1cs(r1cs: R1csFile<32>, wtns: WtnsFile<32>, sym: String, output_path: String) -> Vec<GkrArtifact> {
    let (circuits, inputs, output) = convert_r1cs_wtns_gkr(r1cs, wtns, sym);
    println!("Proving starts..");
    let now = Instant::now();
    let pairs: Vec<(GKRCircuit<Fr>, Input<Fr>)> = circuits.into_iter().zip(inputs).collect();
    let artifacts: Vec<GkrArtifact> = pairs
        .into_par_iter()
        .map(|(circuit, input)| {
            let proof =
                prover::prove::<Fr, MimcTranscript>(&circuit, &input).expect("GKR proving failed");
            verifier::verify::<Fr, MimcTranscript>(
                &circuit,
                &input.input_values,
                &input.output_values,
                &proof,
            )
            .expect("freshly generated GKR proof does not verify");
            GkrArtifact {
                circuit,
                input_values: input.input_values,
                output_values: input.output_values,
                proof,
            }
        })
        .collect();
    println!("{}\n", format!("Proving {}", report_elapsed(now)).blue().bold());
    write_output(output_path, output);
    artifacts
}

/// Named signal inputs of the aggregated circuit for the previous round's proofs.
fn verifier_inputs(artifacts: &[GkrArtifact]) -> Vec<(String, Value)> {
    let mut out = vec![];
    for (num, a) in artifacts.iter().enumerate() {
        let v = gkr_verifier_inputs(&a.circuit, &a.input_values, &a.proof)
            .expect("verifier inputs");
        let parse = |s: &String| serde_json::from_str::<Value>(s).expect("json");
        out.push((format!("gkrInput{num}"), parse(&v.input_values)));
        for (i, r) in v.rounds.iter().enumerate() {
            out.push((format!("gkrRounds{num}_{i}"), parse(r)));
        }
        for (i, q) in v.q.iter().enumerate() {
            out.push((format!("gkrQ{num}_{i}"), parse(q)));
        }
    }
    out
}

/// Inserts one generated, circuit-specific verifier per previous proof into the user's
/// circuit. Output values of R1CS-derived GKR circuits are all zero (every output gate is a
/// constraint A*B - C), so the verifiers are generated for the all-zero output.
fn modify_circom_file(path: String, artifacts: &[GkrArtifact]) -> String {
    let mut templates = String::new();
    let mut instances = String::new();
    for (num, a) in artifacts.iter().enumerate() {
        assert!(a.output_values.iter().all(|v| bool::from(ff::Field::is_zero(v))));
        let name = format!("GkrVerifier{num}");
        templates.push_str(&gkr_verifier_template(&a.circuit, &[], &name).expect("verifier template"));
        templates.push('\n');
        let kd = a.circuit.k(a.circuit.depth());
        instances.push_str(&format!("    signal input gkrInput{num}[{}];\n", 1 << kd));
        instances.push_str(&format!("    component gkrVerifier{num} = {name}();\n"));
        instances.push_str(&format!(
            "    for (var i = 0; i < {}; i++) {{ gkrVerifier{num}.inputValues[i] <== gkrInput{num}[i]; }}\n",
            1 << kd
        ));
        for i in 0..a.circuit.depth() {
            let k = a.circuit.k(i + 1);
            instances.push_str(&format!("    signal input gkrRounds{num}_{i}[{}][3];\n", 2 * k));
            instances.push_str(&format!("    signal input gkrQ{num}_{i}[{}];\n", k + 1));
            instances.push_str(&format!(
                "    for (var j = 0; j < {}; j++) {{ for (var t = 0; t < 3; t++) {{ gkrVerifier{num}.rounds{i}[j][t] <== gkrRounds{num}_{i}[j][t]; }} }}\n",
                2 * k
            ));
            instances.push_str(&format!(
                "    for (var t = 0; t < {}; t++) {{ gkrVerifier{num}.q{i}[t] <== gkrQ{num}_{i}[t]; }}\n",
                k + 1
            ));
        }
    }

    let content = std::fs::read_to_string(&path).expect("original circuit");
    let mut new_circuit = String::new();
    let (mut included, mut defined, mut added) = (false, false, false);
    for line in content.lines() {
        if line.trim_start().starts_with("pragma circom") && !included {
            new_circuit.push_str(line);
            new_circuit.push_str(
                "\ninclude \"../gkr-verifier-circuits/circom/circom/verifier.circom\";\n",
            );
            included = true;
        } else if line.trim_start().starts_with("template") && !defined {
            // generated templates go after the user's includes
            new_circuit.push_str(&templates);
            new_circuit.push_str(line);
            new_circuit.push('\n');
            defined = true;
        } else if line == "}" && !added {
            new_circuit.push_str(&instances);
            new_circuit.push_str("}\n");
            added = true;
        } else {
            new_circuit.push_str(line);
            new_circuit.push('\n');
        }
    }
    assert!(included && defined && added, "could not find the pragma line and the end of the first template");

    let file_path = current_dir().unwrap().join("aggregated.circom");
    std::fs::write(&file_path, new_circuit).expect("Write new circuit failed");
    file_path.into_os_string().into_string().unwrap()
}

fn compile_and_prove(circuit_path: String, input_path: &String, input_name: String) -> Vec<GkrArtifact> {
    let (name, root_path) = execute_circom(circuit_path, input_path);
    let r1cs_path = format!("{}{}.r1cs", root_path, name);
    let r1cs = R1csFile::<32>::read(File::open(r1cs_path).unwrap()).unwrap();
    let sym = format!("{}{}.sym", root_path, name);
    let wtns_path = current_dir().unwrap().join("witness.wtns");
    println!("Writing new witness..");
    let wtns = WtnsFile::<32>::read(File::open(wtns_path).unwrap()).unwrap();
    let output_path = format!("{}{}_output.json", root_path, input_name);
    prove_r1cs(r1cs, wtns, sym, output_path)
}

pub fn prove_recursively_circom(
    circuit_path: String,
    previous: Vec<GkrArtifact>,
    input_path: String,
) -> Vec<GkrArtifact> {
    let aggregated_input_path = write_aggregated_input(input_path.clone(), verifier_inputs(&previous));
    let aggregated_circuit_path = modify_circom_file(circuit_path, &previous);
    println!("{} generated", aggregated_circuit_path);
    compile_and_prove(aggregated_circuit_path, &aggregated_input_path, get_name(&input_path))
}

fn report_elapsed(now: Instant) -> String {
    format!("took {:?} seconds", now.elapsed().as_secs_f32())
}

pub fn prove_groth(circuit_path: String, previous: Vec<GkrArtifact>, input_path: String) {
    let aggregated_input_path = write_aggregated_input(input_path, verifier_inputs(&previous));
    let aggregated_circuit_path = modify_circom_file(circuit_path, &previous);
    execute_circom(aggregated_circuit_path, &aggregated_input_path);
    println!("{}", "Proving by groth16 can be done".bold());
}

pub fn prove_all(circuit_path: String, input_paths: Vec<String>) {
    let mut artifacts: Option<Vec<GkrArtifact>> = None;
    for (i, input) in input_paths.iter().enumerate() {
        if i == 0 {
            artifacts = Some(compile_and_prove(circuit_path.clone(), input, get_name(input)));
        } else if i == input_paths.len() - 1 {
            prove_groth(circuit_path.clone(), artifacts.take().unwrap(), input.clone());
        } else {
            artifacts = Some(prove_recursively_circom(
                circuit_path.clone(),
                artifacts.take().unwrap(),
                input.clone(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::prove_all;

    #[test]
    #[ignore = "requires circom, node and circomlib (run from ./rust)"]
    fn test_proving() {
        let circuit_path = String::from("./t.circom");
        let mut input_paths = vec![];
        input_paths.push(String::from("./example/input1.json"));
        input_paths.push(String::from("./example/input2.json"));
        input_paths.push(String::from("./example/input3.json"));
        prove_all(circuit_path, input_paths);
    }

    #[test]
    #[ignore = "requires circom, node and circomlib (run from ./rust)"]
    fn test_single_proof() {
        let circuit_path = String::from("./t.circom");
        let mut input_paths = vec![];
        input_paths.push(String::from("./example/input1.json"));
        prove_all(circuit_path, input_paths);
    }
}
