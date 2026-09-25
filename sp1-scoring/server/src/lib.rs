mod docker;
pub mod process;

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use fs2::FileExt;
use mania_scoring_core::{evaluate, sha256, PlayInput, PublicValues};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use uuid::Uuid;

pub const BODY_LIMIT: usize = 16 * 1024 * 1024;
const ARTIFACT_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Core,
    Groth16,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Groth16 => "groth16",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofRequest {
    pub mode: Mode,
    pub input: PlayInput,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Running,
    Succeeded,
    Failed,
}
impl Status {
    fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Job {
    pub id: Uuid,
    pub mode: Mode,
    pub status: Status,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub vkey: String,
    pub score: Option<u32>,
    pub error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(temp, path)?;
    Ok(())
}

#[async_trait]
pub trait Backend: Send + Sync {
    fn vkey(&self) -> &str;
    fn groth16_enabled(&self) -> bool;
    async fn prove(
        &self,
        mode: Mode,
        input: &Path,
        dir: &Path,
        stop: &CancellationToken,
    ) -> Result<()>;
}

pub struct LocalProver {
    pub executable: PathBuf,
    pub key: String,
    pub groth16: bool,
    pub timeout: Duration,
}

impl LocalProver {
    pub async fn new(executable: PathBuf, groth16: bool, timeout: Duration) -> Result<Self> {
        let executable = executable
            .canonicalize()
            .context("build mania-sp1-host first or set --host-bin")?;
        let out = process::run(
            &executable,
            &["vkey"],
            Duration::from_secs(120),
            &CancellationToken::new(),
            None,
        )
        .await?;
        let json: serde_json::Value =
            serde_json::from_slice(&out).context("host vkey output is not JSON")?;
        let key = json["vkey"]
            .as_str()
            .context("host did not return a vkey")?
            .to_owned();
        ensure!(
            key.len() == 66 && key.starts_with("0x") && hex::decode(&key[2..]).is_ok(),
            "invalid program key"
        );
        if groth16 {
            ensure!(json["groth16ArtifactsReady"] == true,
                "Groth16 circuit artifacts are not ready; build the current host and run its groth16 warmup command before enabling the API (see server/README.md)");
            let ready = tokio::time::timeout(
                Duration::from_secs(10),
                tokio::process::Command::new("docker")
                    .arg("info")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .status(),
            )
            .await;
            ensure!(
                matches!(ready, Ok(Ok(status)) if status.success()),
                "--enable-groth16 requires a running Docker daemon"
            );
        }
        Ok(Self {
            executable,
            key,
            groth16,
            timeout,
        })
    }
}

#[async_trait]
impl Backend for LocalProver {
    fn vkey(&self) -> &str {
        &self.key
    }
    fn groth16_enabled(&self) -> bool {
        self.groth16
    }
    async fn prove(
        &self,
        mode: Mode,
        input: &Path,
        dir: &Path,
        stop: &CancellationToken,
    ) -> Result<()> {
        let input = input.to_str().context("non-UTF8 input path")?;
        let output = dir.to_str().context("non-UTF8 artifact path")?;
        let scope = if mode == Mode::Groth16 {
            Some(docker::Scope::new(dir)?)
        } else {
            None
        };
        let environment = scope.as_ref().map(|s| s.environment()).unwrap_or_default();
        let result = async {
            let start = tokio::time::Instant::now();
            process::run_env(
                &self.executable,
                &[mode.as_str(), input, output],
                self.timeout,
                stop,
                Some(&dir.join("prover.log")),
                environment,
            )
            .await?;
            let remaining = self
                .timeout
                .checked_sub(start.elapsed())
                .context("prover timeout")?;
            // Re-open and cryptographically verify the saved binary, not merely its JSON success flags.
            process::run_env(
                &self.executable,
                &["verify", input, output],
                remaining,
                stop,
                Some(&dir.join("verify.log")),
                environment,
            )
            .await?;
            Ok(())
        }
        .await;
        if let Some(scope) = scope {
            if let Err(error) = scope.cleanup().await {
                // Do not start another heavy job if an earlier container may still be running.
                stop.cancel();
                return Err(error.context("Docker cleanup failed; server stopping"));
            }
        }
        result
    }
}

pub struct App {
    root: PathBuf,
    jobs: Mutex<HashMap<Uuid, Job>>,
    tx: mpsc::Sender<Uuid>,
    backend: Arc<dyn Backend>,
    token_hash: Option<[u8; 32]>,
    requests: Arc<Semaphore>,
    max_jobs: usize,
    pub stop: CancellationToken,
    _lock: File,
}

impl App {
    /// One worker per data directory; concurrent server instances are excluded with an OS lock.
    pub fn open(
        root: &Path,
        backend: Arc<dyn Backend>,
        token: Option<String>,
        queue_size: usize,
        max_jobs: usize,
    ) -> Result<(Arc<Self>, tokio::task::JoinHandle<()>)> {
        ensure!(
            queue_size > 0 && queue_size <= 128 && max_jobs > 0 && max_jobs <= 10_000,
            "invalid queue/storage limits"
        );
        ensure!(
            token.as_ref().is_none_or(|t| t.len() >= 32),
            "PROVER_API_TOKEN must be at least 32 bytes"
        );
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("server.lock"))?;
        lock.try_lock_exclusive()
            .context("another server owns this data directory")?;
        let metadata = root.join("server.json");
        if metadata.exists() {
            let stored: serde_json::Value = serde_json::from_slice(&fs::read(&metadata)?)?;
            ensure!(
                stored["vkey"] == backend.vkey(),
                "guest vkey changed: use a new --data-dir"
            );
        } else {
            write_json(
                &metadata,
                &serde_json::json!({"vkey": backend.vkey(), "version": 1}),
            )?;
        }
        let mut jobs = HashMap::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let Ok(id) = Uuid::parse_str(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            ensure!(entry.file_type()?.is_dir(), "invalid job directory");
            let path = entry.path().join("job.json");
            if !path.exists() {
                // An interrupted admission may leave input.json without a persisted job record.
                fs::remove_dir_all(entry.path())?;
                continue;
            }
            let mut job: Job = serde_json::from_slice(&fs::read(&path)?)?;
            ensure!(
                job.id == id && job.vkey == backend.vkey(),
                "invalid stored job metadata"
            );
            if !job.status.terminal() {
                job.status = Status::Failed;
                job.error =
                    Some("server restarted before proof completion; submit a new job".into());
                job.updated_at_ms = now();
                write_json(&path, &job)?;
            }
            jobs.insert(id, job);
        }
        let (tx, rx) = mpsc::channel(queue_size);
        let app = Arc::new(Self {
            root,
            jobs: Mutex::new(jobs),
            tx,
            backend,
            token_hash: token.map(|t| sha256(t.as_bytes())),
            requests: Arc::new(Semaphore::new(16)),
            max_jobs,
            stop: CancellationToken::new(),
            _lock: lock,
        });
        let worker = tokio::spawn(work(app.clone(), rx));
        Ok((app, worker))
    }

    async fn update(
        &self,
        id: Uuid,
        status: Status,
        score: Option<u32>,
        error: Option<String>,
    ) -> Result<()> {
        let mut jobs = self.jobs.lock().await;
        let job = jobs.get_mut(&id).context("unknown job")?;
        job.status = status;
        job.updated_at_ms = now();
        job.score = score;
        job.error = error;
        write_json(&self.root.join(id.to_string()).join("job.json"), job)
    }

    pub async fn stop_pending(&self) -> Result<()> {
        let ids: Vec<_> = self
            .jobs
            .lock()
            .await
            .values()
            .filter(|j| !j.status.terminal())
            .map(|j| j.id)
            .collect();
        for id in ids {
            self.update(
                id,
                Status::Failed,
                None,
                Some("server stopped before proof completion".into()),
            )
            .await?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    mode: Mode,
    vkey: String,
    public_values: String,
    proof: Option<String>,
    proof_generated: bool,
    locally_verified: bool,
    result: PublicValues,
}

async fn prove_job(app: &App, job: &Job) -> Result<u32> {
    let dir = app.root.join(job.id.to_string());
    let input = dir.join("input.json");
    let play: PlayInput = serde_json::from_slice(&fs::read(&input)?)?;
    let expected = evaluate(&play).map_err(anyhow::Error::msg)?;
    app.backend.prove(job.mode, &input, &dir, &app.stop).await?;
    ensure!(
        fs::metadata(dir.join("proof.json"))?.len() <= 64 * 1024,
        "proof metadata exceeds size limit"
    );
    let artifact: Artifact = serde_json::from_slice(&fs::read(dir.join("proof.json"))?)?;
    ensure!(
        artifact.mode == job.mode && artifact.vkey == job.vkey,
        "proof mode/program key mismatch"
    );
    ensure!(
        artifact.proof_generated && artifact.locally_verified,
        "proof was not generated and verified"
    );
    ensure!(
        artifact.result == expected
            && artifact.public_values == format!("0x{}", hex::encode(expected.abi_encode())),
        "proof result does not match the submitted play"
    );
    match job.mode {
        Mode::Core => ensure!(
            artifact.proof.is_none(),
            "core proof must not expose EVM bytes"
        ),
        Mode::Groth16 => {
            let proof = artifact.proof.context("missing EVM proof bytes")?;
            ensure!(
                proof.starts_with("0x") && hex::decode(&proof[2..]).is_ok_and(|p| p.len() > 4),
                "invalid EVM proof bytes"
            );
        }
    }
    let size = fs::metadata(dir.join("proof.bin"))?.len();
    ensure!(
        size > 0 && size <= ARTIFACT_LIMIT,
        "proof binary exceeds artifact size limit"
    );
    Ok(expected.score)
}

async fn work(app: Arc<App>, mut rx: mpsc::Receiver<Uuid>) {
    loop {
        let id = tokio::select! { biased;
            _ = app.stop.cancelled() => break,
            id = rx.recv() => match id { Some(id) => id, None => break },
        };
        let job = app.jobs.lock().await.get(&id).cloned();
        let Some(job) = job else {
            continue;
        };
        let result = match app.update(id, Status::Running, None, None).await {
            Ok(()) => prove_job(&app, &job).await,
            Err(error) => Err(error),
        };
        let result = match result {
            Ok(score) => app.update(id, Status::Succeeded, Some(score), None).await,
            Err(error) => {
                eprintln!("job {id} failed: {error:#}");
                // Never serve partial or mismatched proofs after any failure.
                for file in ["proof.bin", "proof.json", "execution.json"] {
                    let _ = fs::remove_file(app.root.join(id.to_string()).join(file));
                }
                app.update(id, Status::Failed, None, Some(error.to_string()))
                    .await
            }
        };
        if let Err(error) = result {
            eprintln!("cannot persist job {id}: {error:#}");
            app.stop.cancel();
            break;
        }
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;
pub struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
fn api_error(code: StatusCode, text: impl Into<String>) -> ApiError {
    ApiError(code, text.into())
}
fn internal(error: impl std::fmt::Display) -> ApiError {
    eprintln!("request failed: {error}");
    api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal storage error")
}

async fn protect(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    if let Some(expected) = app.token_hash {
        let valid = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .is_some_and(|token| bool::from(expected.ct_eq(&sha256(token.as_bytes()))));
        if !valid {
            return api_error(StatusCode::UNAUTHORIZED, "bearer token required").into_response();
        }
    }
    let Ok(_permit) = app.requests.clone().try_acquire_owned() else {
        return api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many concurrent requests",
        )
        .into_response();
    };
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn create(
    State(app): State<Arc<App>>,
    Json(request): Json<ProofRequest>,
) -> ApiResult<impl IntoResponse> {
    if app.stop.is_cancelled() {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "server shutting down",
        ));
    }
    if request.mode == Mode::Groth16 && !app.backend.groth16_enabled() {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Groth16 is disabled; start server with --enable-groth16 and Docker",
        ));
    }
    let permit = app
        .tx
        .clone()
        .try_reserve_owned()
        .map_err(|_| api_error(StatusCode::TOO_MANY_REQUESTS, "proof queue is full"))?;
    let mode = request.mode;
    let play = tokio::task::spawn_blocking(move || evaluate(&request.input).map(|_| request.input))
        .await
        .map_err(internal)?
        .map_err(|e| api_error(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let mut jobs = app.jobs.lock().await;
    if jobs.len() >= app.max_jobs {
        return Err(api_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "job retention limit reached; delete completed jobs",
        ));
    }
    let id = Uuid::new_v4();
    let dir = app.root.join(id.to_string());
    fs::create_dir(&dir).map_err(internal)?;
    let job = Job {
        id,
        mode,
        status: Status::Queued,
        created_at_ms: now(),
        updated_at_ms: now(),
        vkey: app.backend.vkey().into(),
        score: None,
        error: None,
    };
    if let Err(error) = write_json(&dir.join("input.json"), &play)
        .and_then(|_| write_json(&dir.join("job.json"), &job))
    {
        let _ = fs::remove_dir_all(&dir);
        return Err(internal(error));
    }
    jobs.insert(id, job.clone());
    permit.send(id);
    Ok((
        StatusCode::ACCEPTED,
        [(header::LOCATION, format!("/v1/proofs/{id}"))],
        Json(job),
    ))
}

async fn status(
    State(app): State<Arc<App>>,
    RoutePath(id): RoutePath<Uuid>,
) -> ApiResult<Json<Job>> {
    app.jobs
        .lock()
        .await
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "unknown job"))
}

async fn remove(
    State(app): State<Arc<App>>,
    RoutePath(id): RoutePath<Uuid>,
) -> ApiResult<StatusCode> {
    let mut jobs = app.jobs.lock().await;
    let job = jobs
        .get(&id)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "unknown job"))?;
    if !job.status.terminal() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "cannot delete an active job",
        ));
    }
    fs::remove_dir_all(app.root.join(id.to_string())).map_err(internal)?;
    jobs.remove(&id);
    Ok(StatusCode::NO_CONTENT)
}

async fn download(
    State(app): State<Arc<App>>,
    RoutePath((id, file)): RoutePath<(Uuid, String)>,
) -> ApiResult<Response> {
    if !["proof.json", "proof.bin"].contains(&file.as_str()) {
        return Err(api_error(StatusCode::NOT_FOUND, "unknown artifact"));
    }
    let jobs = app.jobs.lock().await;
    let job = jobs
        .get(&id)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "unknown job"))?;
    if job.status != Status::Succeeded {
        return Err(api_error(StatusCode::CONFLICT, "proof is not ready"));
    }
    // Open before releasing the lock, so DELETE cannot unlink the file before it is opened.
    let artifact = tokio::fs::File::open(app.root.join(id.to_string()).join(&file))
        .await
        .map_err(internal)?;
    let size = artifact.metadata().await.map_err(internal)?.len();
    drop(jobs);
    let mime = if file == "proof.json" {
        "application/json"
    } else {
        "application/octet-stream"
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, size)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{file}\""),
        )
        .body(Body::from_stream(ReaderStream::new(artifact)))
        .unwrap())
}

async fn metadata(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"service": "mania-proof-server", "vkey": app.backend.vkey(),
        "modes": if app.backend.groth16_enabled() { vec!["core", "groth16"] } else { vec!["core"] },
        "maxRequestBytes": BODY_LIMIT, "workers": 1, "hardwareSignaturesVerified": false,
        "onchainSubmission": false}),
    )
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/v1/meta", get(metadata))
        .route("/v1/proofs", post(create))
        .route("/v1/proofs/{id}", get(status).delete(remove))
        .route("/v1/proofs/{id}/{file}", get(download))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(middleware::from_fn_with_state(app.clone(), protect))
        .with_state(app)
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
}

#[cfg(test)]
mod tests;
