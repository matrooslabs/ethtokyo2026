use anyhow::{bail, ensure, Context, Result};
use mania_scoring_core::{evaluate, PlayInput};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1ProofWithPublicValues, SP1Stdin,
};
use std::{env, fs, path::PathBuf, time::Instant};

const ELF: Elf = include_elf!("mania-scoring-program");

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let mut args = env::args().skip(1);
    let mode = args
        .next()
        .context("usage: mania-sp1-host vkey [OUTPUT.json] OR execute|core|groth16|verify INPUT.json [ARTIFACT_DIR]")?;
    if mode == "vkey" {
        // A deployment needs the program key before a contract-bound session can exist.
        let client = ProverClient::builder().light().build();
        let pk = client.setup(ELF).context("SP1 setup failed")?;
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "vkey": pk.verifying_key().bytes32(),
            "sp1Version": "6.8.0",
            "groth16ArtifactsReady": groth16_artifacts_ready(),
        }))?;
        if let Some(path) = args.next() {
            fs::write(path, &json)?;
        }
        println!("{json}");
        return Ok(());
    }
    ensure!(
        ["execute", "core", "groth16", "verify"].contains(&mode.as_str()),
        "unsupported mode"
    );
    let input: PlayInput =
        serde_json::from_slice(&fs::read(args.next().context("missing input JSON")?)?)?;
    let dir = PathBuf::from(args.next().unwrap_or_else(|| "artifacts".into()));
    let expected = evaluate(&input).map_err(anyhow::Error::msg)?;
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    // Explicit local clients: SP1_PROVER=mock/network cannot silently change this run.
    let executor = ProverClient::builder().light().build();
    if mode == "verify" {
        let proof = SP1ProofWithPublicValues::load(dir.join("proof.bin"))?;
        let pk = executor.setup(ELF).context("SP1 setup failed")?;
        executor
            .verify(&proof, pk.verifying_key(), None)
            .context("saved proof verification failed")?;
        ensure!(
            proof.public_values.as_slice() == expected.abi_encode(),
            "saved proof does not match this input/session"
        );
        println!(
            "Saved proof verified against this guest and input: {}",
            dir.display()
        );
        return Ok(());
    }
    if mode == "groth16" {
        let docker_ready = std::process::Command::new("docker")
            .arg("info")
            .output()
            .is_ok_and(|output| output.status.success());
        ensure!(docker_ready, "local Groth16 wrapping requires a running Docker daemon; use core to test local proving without Docker");
    }
    fs::create_dir_all(&dir)?;
    let start = Instant::now();
    let (public_values, report) = executor.execute(ELF, stdin.clone()).run()?;
    ensure!(
        public_values.as_slice() == expected.abi_encode(),
        "native/zkVM output mismatch"
    );
    let execution = serde_json::json!({
        "result": expected,
        "notes": input.chart.notes.len(), "events": input.events.len(),
        "cycles": report.total_instruction_count(),
        "executionMillis": start.elapsed().as_millis(),
        "publicValues": format!("0x{}", hex::encode(public_values.as_slice())),
        "proofGenerated": false,
    });
    fs::write(
        dir.join("execution.json"),
        serde_json::to_vec_pretty(&execution)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&execution)?);
    if mode == "execute" {
        return Ok(());
    }

    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(ELF).context("SP1 setup failed")?;
    let start = Instant::now();
    let proof = match mode.as_str() {
        "core" => client.prove(&pk, stdin).run(),
        "groth16" => client.prove(&pk, stdin).groth16().run(),
        _ => bail!("unsupported mode"),
    }
    .context("local proving failed")?;
    client
        .verify(&proof, pk.verifying_key(), None)
        .context("proof verification failed")?;
    ensure!(
        proof.public_values.as_slice() == expected.abi_encode(),
        "proof output mismatch"
    );
    proof.save(dir.join("proof.bin"))?;
    // Core proofs are not EVM proof bytes. Only Groth16 gets a submission fixture.
    let proof_bytes = if mode == "groth16" {
        Some(format!("0x{}", hex::encode(proof.bytes())))
    } else {
        None
    };
    let fixture = serde_json::json!({
        "mode": mode, "vkey": pk.verifying_key().bytes32(),
        "publicValues": format!("0x{}", hex::encode(proof.public_values.as_slice())),
        "proof": proof_bytes, "proofGenerated": true, "locallyVerified": true,
        "provingMillis": start.elapsed().as_millis(), "result": expected,
    });
    fs::write(dir.join("proof.json"), serde_json::to_vec_pretty(&fixture)?)?;
    println!("Verified {mode} proof saved to {}", dir.display());
    Ok(())
}

/// SP1 6.8.0 installs release circuit artifacts atomically and writes this completion marker.
/// Report readiness without triggering a multi-gigabyte download inside an HTTP job.
fn groth16_artifacts_ready() -> bool {
    if std::env::var("SP1_CIRCUIT_MODE").is_ok_and(|mode| mode == "dev") {
        return false;
    }
    let base = std::env::var_os("SP1_GROTH16_CIRCUIT_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".sp1/circuits/groth16"))
        });
    base.is_some_and(|base| {
        base.join(sp1_sdk::SP1_CIRCUIT_VERSION.trim())
            .join(".complete")
            .is_file()
    })
}
