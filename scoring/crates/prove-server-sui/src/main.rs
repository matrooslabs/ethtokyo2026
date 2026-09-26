//! Sui hardware-sealed score bridge. Requires an on-chain Registry and BridgeOS capture.
mod bridge;
mod http;

use anyhow::{ensure, Context, Result};
use clap::Parser;
use mania_gkr_sui::zeromorph::Srs;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(about = "Bridge BridgeOS hardware captures to Sui GKR secure relay payloads")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8092")]
    bind: SocketAddr,
    /// Trusted BLS12-381 powers-of-tau SRS; dev SRS files have known toxic secrets.
    #[arg(long)]
    srs: PathBuf,
    #[arg(long, env = "SUI_RPC_URL")]
    rpc: String,
    #[arg(long, env = "SUI_REGISTRY_ID")]
    registry: String,
    #[arg(long, env = "SUI_PACKAGE_ID")]
    package: String,
    #[arg(long, default_value = "artifacts/sui-proof-jobs")]
    jobs: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let token = std::env::var("PROVER_API_TOKEN").ok();
    ensure!(args.bind.ip().is_loopback() || token.is_some(), "non-loopback bind requires PROVER_API_TOKEN");
    ensure!(token.as_ref().is_none_or(|t| t.len() >= 32), "PROVER_API_TOKEN must be at least 32 bytes");
    let srs = Srs::load(&args.srs).context("loading Sui GKR SRS")?;
    let bridge = Arc::new(bridge::Bridge::new(srs, args.rpc, args.registry, args.package, args.jobs)?);
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(args.bind).await?;
        eprintln!("Sui sealed score bridge on http://{}", listener.local_addr()?);
        http::serve(listener, http::router(bridge, token)).await
    })
}
