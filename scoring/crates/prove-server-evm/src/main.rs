//! Standalone GKR prove server: one binary, POST a play and get its proof back as JSON.
mod capture;
mod chain;
mod competition;
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
    /// Print the exact pinned G1 bank mapping and exit. Does not attest production security.
    #[arg(long)]
    hardware_bank_points: Option<usize>,
    /// Enable paid game routes using this JSON config (or SCORING_CONFIG).
    #[arg(long)]
    competition_config: Option<PathBuf>,
    /// Base directory for paths inside the competition config.
    #[arg(long, default_value = ".")]
    project_root: PathBuf,
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
    let prover: Arc<dyn http::Prove> = Arc::new(prover::GkrProver::new(Srs::load(&args.srs)?));
    eprintln!(
        "SRS loaded in {:.0} ms",
        start.elapsed().as_secs_f64() * 1e3
    );
    if let Some(points) = args.hardware_bank_points {
        ensure!(
            points % 4 == 0 && points <= 200000,
            "bank requires four points per event"
        );
        println!(
            "{}",
            serde_json::json!({"bankHash":format!("0x{}",hex::encode(prover.bank_hash(points)?)),"bankLength":points,"maxEvents":points/4,"srsId":prover.info()["srsId"]})
        );
        return Ok(());
    }
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(args.bind).await?;
        let bind = listener.local_addr()?;
        let busy = Arc::new(tokio::sync::Semaphore::new(1));
        let mut router = http::router_with_busy(prover.clone(), token, busy.clone());
        if let Some(config) = args
            .competition_config
            .or_else(|| std::env::var_os("SCORING_CONFIG").map(PathBuf::from))
        {
            let state =
                competition::Competition::load(&config, &args.project_root, bind, prover, busy)?;
            router = router.merge(competition::router(state));
            eprintln!("Paid competition routes enabled");
        }
        eprintln!("GKR prove server on http://{bind}");
        http::serve(listener, router).await
    })
}
