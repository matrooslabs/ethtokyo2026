use clap::{Parser, Subcommand};
use std::io::{self, Write};
use std::{io::Result, process::Command};

extern crate gkr;
use gkr::aggregator::prove_all;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Prove {
        #[arg(short, long)]
        circuit: String,
        #[arg(short, long, num_args=0..)]
        inputs: Vec<String>,
    },
    MockGroth {
        #[arg(short, long)]
        zkey: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Prove { circuit, inputs }) => {
            let circuit_path = circuit.clone();
            let input_paths = inputs.clone();
            prove_all(circuit_path, input_paths);
        }
        Some(Commands::MockGroth { zkey }) => {
            // DEV ONLY: the README's zkey is made with a single "mock" contribution and a
            // fixed public beacon, so its toxic waste is known to whoever ran it. Proofs
            // under such a key are forgeable and must never be accepted in production.
            eprintln!("WARNING: mock groth16 setup - proofs are NOT sound with a mock zkey");
            let output = Command::new("snarkjs")
                .arg("zkey")
                .arg("verify")
                .arg("aggregated.r1cs")
                .arg("pot.ptau")
                .arg(zkey.clone())
                .output()
                .expect("failed to run snarkjs");
            std::io::stdout().write_all(&output.stdout).unwrap();
            if !output.status.success() {
                eprintln!("zkey verification failed");
                std::process::exit(1);
            }
            let output = Command::new("snarkjs")
                .arg("groth16")
                .arg("prove")
                .arg(zkey.clone())
                .arg("witness.wtns")
                .arg("proof.json")
                .arg("public.json")
                .output()
                .expect("failed to run snarkjs");
            std::io::stdout().write_all(&output.stdout).unwrap();
            if !output.status.success() {
                eprintln!("groth16 proving failed");
                std::process::exit(1);
            }
            println!("Aggregation is done.");
        }
        None => {}
    }

    Ok(())
}
