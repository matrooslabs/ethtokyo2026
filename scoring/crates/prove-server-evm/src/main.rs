//! Standalone GKR prove server: one binary, POST a play and get its proof back as JSON.
mod http;
mod prover;

use anyhow::{ensure, Result};
use clap::Parser;
use mania_gkr::zeromorph::Srs;
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};

#[derive(Parser)]
#[command(about = "Standalone GKR prove server: POST /v1/prove with a play, get the proof as JSON")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8091")]
    bind: SocketAddr,
    /// SRS file. `mania-gkr srs --smax N` makes an INSECURE dev SRS; use a ceremony .ptau in production.
    #[arg(long, default_value = "artifacts/dev-srs-22.bin")]
    srs: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let token = std::env::var("PROVER_API_TOKEN").ok();
    ensure!(
        args.bind.ip().is_loopback() || token.is_some(),
        "non-loopback bind requires PROVER_API_TOKEN"
    );
    ensure!(
        token.as_ref().is_none_or(|t| t.len() >= 32),
        "PROVER_API_TOKEN must be at least 32 bytes"
    );
    let start = Instant::now();
    let prover = prover::GkrProver::new(Srs::load(&args.srs)?);
    eprintln!("SRS loaded in {:.0} ms", start.elapsed().as_secs_f64() * 1e3);
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(args.bind).await?;
        eprintln!("GKR prove server on http://{}", listener.local_addr()?);
        http::serve(listener, http::router(Arc::new(prover), token)).await
    })
}
