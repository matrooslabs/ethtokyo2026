use ff::PrimeField;
use halo2curves::bn256::Fr;
use num_bigint::BigInt;
use num_traits::Num;
use serde::{Deserialize, Serialize};
use serde_json::{from_reader, from_str, Value};
use std::collections::HashMap;
use std::env::current_dir;
use std::fs;
use std::process::Command;

use crate::convert::Output;

#[derive(Serialize, Deserialize, Debug)]
struct Data {
    value_map: HashMap<String, String>,
}

pub fn stringify_fr(f: &Fr) -> String {
    let r = f.to_repr();
    let mut s = String::from("");
    for &b in r.as_ref().iter().rev() {
        s = format!("{}{:02x}", s, b);
    }
    let decimal = BigInt::from_str_radix(&s, 16).unwrap().to_str_radix(10);
    decimal
}

fn make_output_value_map(output: Output<Fr>) -> Data {
    let mut value_map = HashMap::new();
    for (k, i) in output.wire_map.iter() {
        let name = output
            .get_name(k.clone())
            .expect("Wire map and name map should have a same key");
        let value = stringify_fr(i);
        value_map.insert(name, value);
    }
    Data { value_map }
}

pub fn write_output(path: String, output: Output<Fr>) {
    let data = make_output_value_map(output);
    let json_string = serde_json::to_string(&data.value_map).unwrap();

    fs::write(path, json_string).expect("Unable to write file");
}

pub fn write_aggregated_input(path: String, inputs: Vec<(String, Value)>) -> String {
    let file = fs::File::open(path).unwrap();
    let mut input_json: HashMap<String, Value> = from_reader(file).unwrap();
    for (k, v) in inputs {
        // A user input with the same name must not silently replace proof data (or vice versa).
        assert!(
            input_json.insert(k.clone(), v).is_none(),
            "input name {k} collides with a GKR verifier input"
        );
    }
    let json_string = serde_json::to_string_pretty(&input_json).unwrap();

    let root = current_dir().unwrap();
    let new_path = root.join("aggregated.json");
    fs::write(&new_path, json_string).unwrap();
    new_path.into_os_string().into_string().unwrap()
}

pub fn get_name(path: &String) -> String {
    let binding = path.clone();
    let path_str: Vec<&str> = binding.as_str().split('/').collect();
    let name_tuple: Vec<&str> = path_str[path_str.len() - 1].split('.').collect();
    String::from(name_tuple[0])
}

pub fn execute_circom(path: String, input_path: &String) -> (String, String) {
    // Upstream ignored both exit statuses, so a failed compilation or a witness that
    // violates an assertion (e.g. a rejected GKR proof) silently reused stale
    // r1cs/witness files from an earlier run.
    let path_str: Vec<&str> = path.as_str().split('/').collect();
    let mut path_cloned = path_str.clone();
    path_cloned.pop();
    let mut root_path = String::new();
    for slice in path_cloned {
        root_path = format!("{}{}/", root_path, slice);
    }
    let circom_name: Vec<&str> = path_str[path_str.len() - 1].split('.').collect();
    let name = circom_name[0];

    let witness_path = current_dir().unwrap().join("witness.wtns");
    let _ = fs::remove_file(&witness_path);
    let _ = fs::remove_file(format!("{}{}.r1cs", root_path, name));

    let output = Command::new("circom")
        .arg(path.clone())
        .arg("--r1cs")
        .arg("--sym")
        .arg("--wasm")
        .output()
        .expect("failed to run circom");
    assert!(
        output.status.success(),
        "circom failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let witness_gen_name = format!("{}_js/", name);
    let witness_gen_file = current_dir()
        .unwrap()
        .join(witness_gen_name.clone())
        .join("generate_witness.js");
    let wasm = current_dir()
        .unwrap()
        .join(witness_gen_name)
        .join(format!("{}.wasm", name));

    let status = Command::new("node")
        .arg(witness_gen_file.clone())
        .arg(wasm)
        .arg(input_path.clone())
        .arg("witness.wtns")
        .status()
        .expect("failed to run node");
    assert!(
        status.success(),
        "witness generation failed (constraint violated or bad input)"
    );
    (String::from(name), root_path)
}
