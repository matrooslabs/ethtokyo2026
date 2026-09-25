use anyhow::{bail, Context, Result};
use std::{ffi::OsString, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

const LOG_BYTES: usize = 64 * 1024;

async fn drain(mut source: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    while let Ok(n) = source.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        // Keep draining after reaching the cap, so a verbose prover cannot block on a full pipe.
        let keep = n.min(LOG_BYTES - result.len());
        result.extend_from_slice(&buffer[..keep]);
    }
    result
}

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SP1 may spawn executor helpers. Kill the entire process group on timeout/shutdown.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

async fn capture(mut task: tokio::task::JoinHandle<Vec<u8>>) -> Vec<u8> {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(bytes)) => bytes,
        _ => {
            task.abort();
            b"output capture interrupted".to_vec()
        }
    }
}

/// No shell, no user-controlled executable/arguments, bounded output and a wall-clock deadline.
pub async fn run(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    stop: &CancellationToken,
    log: Option<&Path>,
) -> Result<Vec<u8>> {
    run_env(executable, args, timeout, stop, log, &[]).await
}

pub async fn run_env(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    stop: &CancellationToken,
    log: Option<&Path>,
    environment: &[(OsString, OsString)],
) -> Result<Vec<u8>> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("RUST_LOG", "warn")
        .envs(environment.iter().cloned())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().context("could not start prover process")?;
    let group = ProcessGroup(child.id().context("missing process ID")?);
    let stdout = tokio::spawn(drain(child.stdout.take().unwrap()));
    let stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
    let status = tokio::select! {
        result = child.wait() => result.context("could not wait for prover"),
        _ = tokio::time::sleep(timeout) => Err(anyhow::anyhow!("prover timeout")),
        _ = stop.cancelled() => Err(anyhow::anyhow!("server shutting down")),
    };
    drop(group);
    if status.is_err() {
        let _ = child.kill().await;
    }
    let (out, err) = tokio::join!(capture(stdout), capture(stderr));
    if let Some(path) = log {
        let mut contents = out.clone();
        contents.extend_from_slice(b"\n--- stderr (both streams capped at 64KiB) ---\n");
        contents.extend_from_slice(&err);
        tokio::fs::write(path, contents).await?;
    }
    if !status?.success() {
        bail!("prover process failed; see the job's local log");
    }
    Ok(out)
}
