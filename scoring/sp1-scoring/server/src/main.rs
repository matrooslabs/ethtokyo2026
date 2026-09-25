use anyhow::{ensure, Result};
use clap::Parser;
use mania_proof_server::{router, App, LocalProver};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

#[derive(Parser)]
#[command(about = "Bounded, persistent local SP1 proving API (single worker)")]
struct Args {
    #[arg(long, default_value = "127.0.0.1:8080")]
    bind: SocketAddr,
    #[arg(long, default_value = "host/target/release/mania-sp1-host")]
    host_bin: PathBuf,
    #[arg(long, default_value = "artifacts/server")]
    data_dir: PathBuf,
    #[arg(long, default_value_t = 8)]
    queue_size: usize,
    #[arg(long, default_value_t = 64)]
    max_jobs: usize,
    #[arg(long, default_value_t = 1800)]
    timeout_seconds: u64,
    #[arg(long)]
    enable_groth16: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let token = std::env::var("PROVER_API_TOKEN").ok();
    ensure!(
        args.bind.ip().is_loopback() || token.is_some(),
        "non-loopback bind requires PROVER_API_TOKEN"
    );
    ensure!(args.timeout_seconds > 0, "timeout must be positive");
    let backend = Arc::new(
        LocalProver::new(
            args.host_bin,
            args.enable_groth16,
            Duration::from_secs(args.timeout_seconds),
        )
        .await?,
    );
    let (app, worker) = App::open(
        &args.data_dir,
        backend,
        token,
        args.queue_size,
        args.max_jobs,
    )?;
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    eprintln!(
        "SP1 proving API listening on http://{} (one worker)",
        listener.local_addr()?
    );
    let stop = app.stop.clone();
    let server = axum::serve(listener, router(app.clone())).with_graceful_shutdown(async move {
        #[cfg(unix)] {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {}, _ = stop.cancelled() => {} }
        }
        #[cfg(not(unix))]
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = stop.cancelled() => {} }
        stop.cancel();
    }).await;
    app.stop.cancel();
    worker.await?;
    app.stop_pending().await?;
    server?;
    Ok(())
}
