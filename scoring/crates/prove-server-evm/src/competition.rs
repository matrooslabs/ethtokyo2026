//! Paid game API, capture, proof generation and transaction/job lifecycle in one server.
use crate::{
    capture::{self, ParsedChart},
    chain::{self, Chain, Manifest, Registry, Submission},
    http::Prove,
};
use alloy::{
    primitives::{Address, Bytes, B256, U256},
    providers::Provider,
    signers::{local::PrivateKeySigner, SignerSync},
};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use mania_scoring_core::{
    chart_hash, evaluate, session_digest, trace_root, PlayInput, SessionFooter,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    manifest: PathBuf,
    rpc_url: String,
    relayer_key_file: PathBuf,
    #[serde(default)]
    allowed_origins: Vec<String>,
    #[serde(default = "confirmations")]
    confirmations: u64,
    capture_mode: String,
    hardware_url: Option<String>,
    hardware_token: Option<String>,
    demo_device_key_file: Option<PathBuf>,
    proving_buffer_seconds: u64,
    #[serde(default)]
    proving_buffer_measured: bool,
    #[serde(default)]
    charts: Vec<ChartConfig>,
    job_store_file: Option<PathBuf>,
}
fn confirmations() -> u64 {
    2
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartConfig {
    osu_file: PathBuf,
    chart_hash: B256,
    device: Address,
}
struct GameChart {
    parsed: ParsedChart,
    hash: B256,
    device: Address,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    session_id: B256,
    entry_tx_hash: B256,
    player: Address,
    chart_hash: B256,
    day_id: u64,
    web_beatmap_hash: String,
    capture_mode: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    #[serde(flatten)]
    attempt: Attempt,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    status: String,
    session_id: B256,
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction_hash: Option<B256>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(default)]
    retryable: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    starts: BTreeMap<B256, Started>,
    jobs: BTreeMap<String, Job>,
}
impl Store {
    fn load(path: &FsPath) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        // Accept checkpoints made by the former Node service as well as native maps.
        for field in ["starts", "jobs"] {
            if let Some(rows) = value[field].as_array() {
                let mut map = serde_json::Map::new();
                for row in rows {
                    map.insert(
                        row[0].as_str().context("invalid checkpoint key")?.into(),
                        row[1].clone(),
                    );
                }
                value[field] = Value::Object(map);
            }
        }
        let mut store: Self = serde_json::from_value(value)?;
        for start in store.starts.values_mut() {
            if let Some(id) = start.job_id.clone() {
                if store.jobs.get(&id).is_some_and(|j| {
                    j.transaction_hash.is_none() && j.status != "confirmed" && j.status != "failed"
                }) {
                    store.jobs.remove(&id);
                    start.job_id = None;
                }
            }
        }
        Ok(store)
    }
    fn save(&self, path: &FsPath) -> Result<()> {
        use std::io::Write;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec(self)?)?;
        file.sync_all()?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

pub struct Competition {
    cfg: Config,
    chain: Chain,
    charts: BTreeMap<String, GameChart>,
    demo: Option<PrivateKeySigner>,
    prover: Arc<dyn Prove>,
    busy: Arc<Semaphore>,
    jobs: Mutex<Store>,
    job_path: PathBuf,
    client: reqwest::Client,
    bind: SocketAddr,
}
impl Competition {
    pub fn load(
        file: &FsPath,
        root: &FsPath,
        bind: SocketAddr,
        prover: Arc<dyn Prove>,
        busy: Arc<Semaphore>,
    ) -> Result<Arc<Self>> {
        ensure!(
            bind.ip().is_loopback(),
            "paid scoring is a loopback-only single-user service"
        );
        let cfg: Config = serde_json::from_slice(&std::fs::read(file)?)?;
        ensure!(
            ["hardware", "software-demo"].contains(&cfg.capture_mode.as_str()),
            "choose hardware or software-demo capture"
        );
        ensure!(
            cfg.confirmations > 0 && cfg.confirmations <= 10000,
            "invalid confirmations"
        );
        for origin in &cfg.allowed_origins {
            let u = reqwest::Url::parse(origin)?;
            ensure!(
                ["http", "https"].contains(&u.scheme())
                    && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                    && u.origin().ascii_serialization() == *origin,
                "only exact loopback web origins are supported"
            );
        }
        let manifest: Manifest = serde_json::from_slice(&std::fs::read(root.join(&cfg.manifest))?)?;
        ensure!(
            prover.info()["srsId"]
                .as_str()
                .context("prover SRS id missing")?
                .parse::<B256>()?
                == manifest.srs_id,
            "loaded SRS does not match deployment"
        );
        let relayer = chain::signer(&root.join(&cfg.relayer_key_file))?;
        let demo = if cfg.capture_mode == "software-demo" {
            Some(chain::signer(
                &root.join(
                    cfg.demo_device_key_file
                        .as_ref()
                        .context("demoDeviceKeyFile required")?,
                ),
            )?)
        } else {
            None
        };
        ensure!(
            demo.as_ref()
                .is_none_or(|d| d.address() != relayer.address()),
            "demo device key must differ from relayer key"
        );
        let mut charts = BTreeMap::new();
        for c in &cfg.charts {
            let parsed = capture::parse_osu(&std::fs::read(root.join(&c.osu_file))?)?;
            ensure!(
                B256::from(chart_hash(&parsed.chart)) == c.chart_hash,
                "configured chart hash does not match osu notes"
            );
            charts.insert(
                parsed.web_hash.clone(),
                GameChart {
                    parsed,
                    hash: c.chart_hash,
                    device: c.device,
                },
            );
        }
        let job_path = root.join(cfg.job_store_file.clone().unwrap_or_else(|| {
            format!(
                "scoring/data/jobs-{}-{}.json",
                manifest.chain_id, manifest.contracts.board
            )
            .into()
        }));
        let jobs = Store::load(&job_path)?;
        jobs.save(&job_path)?;
        let chain = Chain::new(&cfg.rpc_url, manifest, relayer, cfg.confirmations)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Arc::new(Self {
            cfg,
            chain,
            charts,
            demo,
            prover,
            busy,
            jobs: Mutex::new(jobs),
            job_path,
            client,
            bind,
        }))
    }
    async fn adapter(&self, route: &str, body: Option<Value>) -> Result<Value> {
        let base = self
            .cfg
            .hardware_url
            .as_ref()
            .context("hardware adapter not configured")?;
        let url = reqwest::Url::parse(base)?.join(route)?;
        let mut request = if let Some(body) = body {
            self.client.post(url).json(&body)
        } else {
            self.client.get(url)
        };
        if let Some(token) = &self.cfg.hardware_token {
            request = request.bearer_auth(token)
        }
        Ok(request.send().await?.error_for_status()?.json().await?)
    }
    async fn ready(&self, c: &GameChart) -> Result<()> {
        ensure!(
            self.cfg.proving_buffer_measured && self.cfg.proving_buffer_seconds > 0,
            "measure and configure proving buffer before paid play"
        );
        self.chain.wiring().await?;
        self.chain.ready_chart(c.hash, c.device).await?;
        if let Some(demo) = &self.demo {
            ensure!(
                demo.address() == c.device,
                "demo signer does not match chart device"
            );
        } else {
            let health = self.adapter("/health", None).await?;
            ensure!(
                health["ready"] == true
                    && health["device"]
                        .as_str()
                        .context("hardware device missing")?
                        .parse::<Address>()?
                        == c.device,
                "physical device unavailable"
            );
        }
        Ok(())
    }
    async fn bound(&self, a: &Attempt) -> Result<chain::Session> {
        self.chain
            .bound(
                a.session_id,
                a.chart_hash,
                a.player,
                a.day_id,
                a.entry_tx_hash,
            )
            .await
    }
    async fn set_job(&self, id: &str, update: impl FnOnce(&mut Job)) -> Result<()> {
        let mut store = self.jobs.lock().await;
        update(store.jobs.get_mut(id).context("job missing")?);
        store.save(&self.job_path)
    }
    async fn reconcile(&self, id: &str) -> Result<Job> {
        let job = self
            .jobs
            .lock()
            .await
            .jobs
            .get(id)
            .cloned()
            .context("unknown job")?;
        if let Some(hash) = job.transaction_hash {
            if let Some(receipt) = self.chain.provider.get_transaction_receipt(hash).await? {
                if self.chain.provider.get_block_number().await?
                    >= receipt.block_number.context("receipt block missing")?
                        + self.chain.confirmations
                        - 1
                {
                    let success = receipt.status() && self.chain.scored(job.session_id).await?;
                    self.set_job(id, |j| {
                        j.status = if success { "confirmed" } else { "failed" }.into();
                        j.retryable = false;
                        j.message = if success {
                            None
                        } else {
                            Some("transaction did not record paid score".into())
                        };
                    })
                    .await?;
                }
            }
        }
        Ok(self.jobs.lock().await.jobs.get(id).unwrap().clone())
    }
    async fn submit(
        self: Arc<Self>,
        job_id: String,
        start: Attempt,
        body: Value,
        permit: OwnedSemaphorePermit,
    ) {
        let result = self.submit_inner(&job_id, &start, body, permit).await;
        if let Err(error) = result {
            if let Err(save) = self
                .set_job(&job_id, |j| {
                    j.status = "failed".into();
                    j.message = Some(error.to_string());
                    j.retryable = j.transaction_hash.is_none();
                })
                .await
            {
                eprintln!("cannot save failed job: {save}");
            }
        }
    }
    async fn submit_inner(
        &self,
        id: &str,
        start: &Attempt,
        body: Value,
        permit: OwnedSemaphorePermit,
    ) -> Result<()> {
        self.set_job(id, |j| j.status = "proving".into()).await?;
        let session = self.bound(start).await?;
        let c = self
            .charts
            .get(&start.web_beatmap_hash)
            .context("unknown chart")?;
        let header = session.header.core();
        let (input, signature) = if self.demo.is_none() {
            self.set_job(id, |j| j.status = "capturing".into()).await?;
            let sealed = self
                .adapter(
                    &format!("/sessions/{}/seal", start.session_id),
                    Some(json!({})),
                )
                .await?;
            let input: PlayInput = serde_json::from_value(sealed["input"].clone())?;
            ensure!(
                serde_json::to_value(&input.chart)? == serde_json::to_value(&c.parsed.chart)?,
                "hardware chart differs from registered chart"
            );
            let signature = capture::validate_seal(
                &header,
                &input,
                sealed["signature"]
                    .as_str()
                    .context("hardware signature missing")?,
            )?;
            (input, Some(signature))
        } else {
            let events = capture::replay_events(&body, &c.parsed)?;
            let duration =
                (c.parsed.max_end + 136500).max(events.last().map_or(0, |e| e.timestamp_us));
            let footer = SessionFooter {
                event_count: events.len() as u32,
                duration_us: duration,
                trace_root: trace_root(&header.session_id, &events),
            };
            (
                PlayInput {
                    header,
                    footer,
                    chart: c.parsed.chart.clone(),
                    events,
                },
                None,
            )
        };
        evaluate(&input).map_err(anyhow::Error::msg)?;
        let digest = B256::from(session_digest(&input.header, &input.footer));
        self.set_job(id, |j| j.status = "proving".into()).await?;
        let prover = self.prover.clone();
        let play = input.clone();
        // The permit lives in the blocking worker if the request/task is cancelled.
        let (proof, permit) = tokio::task::spawn_blocking(move || {
            let result = prover.prove("calldata", &play);
            (result, permit)
        })
        .await?;
        let proof = proof?;
        ensure!(
            proof["sessionDigest"]
                .as_str()
                .context("missing proof digest")?
                .parse::<B256>()?
                == digest,
            "proof does not match gameplay seal"
        );
        let signature = match signature {
            Some(s) => s,
            None => self
                .demo
                .as_ref()
                .context("demo signer missing")?
                .sign_hash_sync(&digest)?
                .as_bytes()
                .to_vec(),
        };
        self.bound(start).await?;
        let lane_bits: Vec<u8> = serde_json::from_value(proof["laneBits"].clone())?;
        let counts: Vec<u32> = serde_json::from_value(proof["counts"].clone())?;
        let sub = Submission {
            duration: input.footer.duration_us,
            laneBits: lane_bits
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid lane bits"))?,
            counts: counts
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid counts"))?,
        };
        let words = proof["proof"]
            .as_array()
            .context("missing proof words")?
            .iter()
            .map(|w| {
                w.as_str()
                    .context("invalid word")?
                    .parse::<U256>()
                    .map_err(Into::into)
            })
            .collect::<Result<Vec<_>>>()?;
        let events = mania_gkr::forge::events_bytes(&input);
        self.set_job(id, |j| j.status = "submitting".into()).await?;
        let registry = Registry::new(self.chain.manifest.contracts.registry, &self.chain.provider);
        let call = registry
            .submitCalldata(
                start.session_id,
                Bytes::from(events),
                sub,
                words,
                Bytes::from(signature),
            )
            .from(self.chain.relayer);
        let gas = call
            .estimate_gas()
            .await?
            .checked_mul(12)
            .context("gas overflow")?
            / 10;
        ensure!(gas <= 16777216, "proof exceeds transaction gas cap");
        let pending = call.gas(gas).send().await?;
        let hash = *pending.tx_hash();
        self.set_job(id, |j| j.transaction_hash = Some(hash))
            .await?;
        let receipt = pending
            .with_required_confirmations(self.chain.confirmations)
            .get_receipt()
            .await?;
        ensure!(
            receipt.status() && self.chain.scored(start.session_id).await?,
            "transaction did not record paid score"
        );
        self.set_job(id, |j| {
            j.status = "confirmed".into();
            j.message = None;
            j.retryable = false;
        })
        .await?;
        drop(permit);
        Ok(())
    }
}

fn failure(status: StatusCode, error: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error":error.to_string()}))).into_response()
}
async fn chart(State(s): State<Arc<Competition>>, Path(hash): Path<String>) -> Response {
    let Some(c) = s.charts.get(&hash) else {
        return failure(StatusCode::NOT_FOUND, "unsupported chart");
    };
    let ready = s.ready(c).await;
    Json(json!({"chartHash":c.hash,"webBeatmapHash":hash,"device":c.device,"durationSeconds":(c.parsed.max_end+136500).div_ceil(1_000_000),"provingBufferSeconds":s.cfg.proving_buffer_seconds,"chainId":s.chain.manifest.chain_id,"leaderboard":s.chain.manifest.contracts.board,"captureMode":s.cfg.capture_mode,"ready":ready.is_ok(),"reason":ready.err().map(|e|e.to_string())})).into_response()
}
async fn start(
    State(s): State<Arc<Competition>>,
    Path(id): Path<B256>,
    Json(a): Json<Attempt>,
) -> Response {
    async fn run(s: &Competition, id: B256, a: Attempt) -> Result<Value> {
        ensure!(
            a.session_id == id && a.capture_mode == s.cfg.capture_mode,
            "session/capture mismatch"
        );
        let c = s
            .charts
            .get(&a.web_beatmap_hash)
            .context("unsupported chart")?;
        ensure!(c.hash == a.chart_hash, "chart mismatch");
        s.ready(c).await?;
        let session = s.bound(&a).await?;
        ensure!(session.header.device == c.device, "paid device mismatch");
        if s.demo.is_none() {
            s.adapter(
                &format!("/sessions/{id}/start"),
                Some(json!({"header":session.header.adapter_json(),"chart":c.parsed.chart})),
            )
            .await?;
        }
        let mut store = s.jobs.lock().await;
        let job_id = store.starts.get(&id).and_then(|a| a.job_id.clone());
        store.starts.insert(id, Started { attempt: a, job_id });
        store.save(&s.job_path)?;
        Ok(json!({"sessionId":id,"captureMode":s.cfg.capture_mode}))
    }
    match run(&s, id, a).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => failure(StatusCode::BAD_REQUEST, e),
    }
}
async fn proof(
    State(s): State<Arc<Competition>>,
    Path(id): Path<B256>,
    Json(body): Json<Value>,
) -> Response {
    // Validate outside the lock, then recheck job identity while holding it.
    let start = match s.jobs.lock().await.starts.get(&id).cloned() {
        Some(a) => a,
        None => return failure(StatusCode::BAD_REQUEST, "start session first"),
    };
    if body["webBeatmapHash"].as_str() != Some(&start.attempt.web_beatmap_hash) {
        return failure(StatusCode::BAD_REQUEST, "chart mismatch");
    }
    if let Some(old_id) = &start.job_id {
        if let Some(job) = s.jobs.lock().await.jobs.get(old_id) {
            if body["retry"] != true || job.status != "failed" || job.transaction_hash.is_some() {
                return Json(json!({"jobId":old_id})).into_response();
            }
        }
    }
    if let Err(e) = s.bound(&start.attempt).await {
        return failure(StatusCode::BAD_REQUEST, e);
    }
    if s.demo.is_some() {
        let c = &s.charts[&start.attempt.web_beatmap_hash];
        if let Err(e) = capture::replay_events(&body, &c.parsed) {
            return failure(StatusCode::BAD_REQUEST, e);
        }
    }
    let mut store = s.jobs.lock().await;
    let current = store.starts.get(&id).unwrap().clone();
    if let Some(old_id) = &current.job_id {
        if let Some(job) = store.jobs.get(old_id) {
            if body["retry"] != true || job.status != "failed" || job.transaction_hash.is_some() {
                return Json(json!({"jobId":old_id})).into_response();
            }
        }
    }
    let Ok(permit) = s.busy.clone().try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "prover busy; retry shortly",
        );
    };
    let job_id = uuid::Uuid::new_v4().to_string();
    store.starts.get_mut(&id).unwrap().job_id = Some(job_id.clone());
    store.jobs.insert(
        job_id.clone(),
        Job {
            status: "queued".into(),
            session_id: id,
            transaction_hash: None,
            message: None,
            retryable: false,
        },
    );
    if let Err(e) = store.save(&s.job_path) {
        store.jobs.remove(&job_id);
        store.starts.insert(id, current);
        return failure(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    drop(store);
    tokio::spawn(
        s.clone()
            .submit(job_id.clone(), start.attempt, body, permit),
    );
    (StatusCode::ACCEPTED, Json(json!({"jobId":job_id}))).into_response()
}
async fn job(State(s): State<Arc<Competition>>, Path(id): Path<String>) -> Response {
    if !s.jobs.lock().await.jobs.contains_key(&id) {
        return failure(StatusCode::NOT_FOUND, "unknown job");
    }
    match s.reconcile(&id).await {
        Ok(job) => Json(job).into_response(),
        Err(e) => failure(StatusCode::BAD_GATEWAY, e),
    }
}
async fn local(
    State(s): State<Arc<Competition>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let valid_host = ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| host == format!("{h}:{}", s.bind.port()) || (s.bind.port() == 80 && host == *h));
    if !peer.ip().is_loopback() || !valid_host {
        return failure(StatusCode::FORBIDDEN, "loopback clients only");
    }
    let origin = headers.get(header::ORIGIN).cloned();
    if origin
        .as_ref()
        .is_some_and(|o| !s.cfg.allowed_origins.iter().any(|v| o == v.as_str()))
    {
        return failure(StatusCode::FORBIDDEN, "origin not allowed");
    }
    if request.method() == Method::POST
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next().unwrap_or("").trim() != "application/json")
    {
        return failure(StatusCode::FORBIDDEN, "JSON content type required");
    }
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, "Origin".parse().unwrap());
    }
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET,POST,OPTIONS".parse().unwrap(),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Content-Type".parse().unwrap(),
    );
    response
}
pub fn router(state: Arc<Competition>) -> Router {
    Router::new()
        .route("/charts/{hash}", get(chart))
        .route("/sessions/{id}/start", post(start))
        .route("/sessions/{id}/proof", post(proof))
        .route("/jobs/{id}", get(job))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), local))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    struct Fake;
    impl Prove for Fake {
        fn info(&self) -> Value {
            json!({"srsId":B256::repeat_byte(1)})
        }
        fn modes(&self) -> &'static [&'static str] {
            &["calldata"]
        }
        fn prove(&self, _: &str, _: &PlayInput) -> Result<Value> {
            unreachable!()
        }
    }
    fn directory() -> PathBuf {
        let p = std::env::temp_dir().join(format!("scoring-config-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn config(root: &FsPath) -> PathBuf {
        std::fs::write(root.join("key"), format!("{:064x}", 1)).unwrap();
        std::fs::write(root.join("manifest.json"),json!({"chainId":31337,"srsId":B256::repeat_byte(1),"token":Address::repeat_byte(1),"contracts":{"DailyLeaderboard":Address::repeat_byte(2),"ManiaGkrRegistry":Address::repeat_byte(3),"GkrScoreVerifier":Address::repeat_byte(4)}}).to_string()).unwrap();
        let file = root.join("config.json");
        std::fs::write(&file,json!({"manifest":"manifest.json","rpcUrl":"http://127.0.0.1:1","relayerKeyFile":"key","captureMode":"hardware","provingBufferSeconds":180,"allowedOrigins":["http://localhost:3000"]}).to_string()).unwrap();
        file
    }
    async fn call(app: &Router, method: &str, host: &str, origin: &str, peer: &str) -> StatusCode {
        let mut request = HttpRequest::builder()
            .method(method)
            .uri("/charts/unknown")
            .header("host", host)
            .header("origin", origin)
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        app.clone().oneshot(request).await.unwrap().status()
    }
    #[tokio::test]
    async fn paid_routes_enforce_loopback_host_origin_and_preflight() {
        let dir = directory();
        let file = config(&dir);
        let state = Competition::load(
            &file,
            &dir,
            "127.0.0.1:8091".parse().unwrap(),
            Arc::new(Fake),
            Arc::new(Semaphore::new(1)),
        )
        .unwrap();
        let app = router(state);
        assert_eq!(
            call(
                &app,
                "GET",
                "127.0.0.1:8091",
                "http://localhost:3000",
                "127.0.0.1:1234"
            )
            .await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "evil.example:8091",
                "http://localhost:3000",
                "127.0.0.1:1234"
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "127.0.0.1:8091",
                "https://evil.example",
                "127.0.0.1:1234"
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "127.0.0.1:8091",
                "http://localhost:3000",
                "192.168.1.4:1234"
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "OPTIONS",
                "127.0.0.1:8091",
                "http://localhost:3000",
                "127.0.0.1:1234"
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert!(Competition::load(
            &file,
            &dir,
            "0.0.0.0:8091".parse().unwrap(),
            Arc::new(Fake),
            Arc::new(Semaphore::new(1))
        )
        .is_err());
        // Raw API authentication remains independent of the browser's local session routes.
        let raw = crate::http::router_with_busy(
            Arc::new(Fake),
            Some("secret".into()),
            Arc::new(Semaphore::new(1)),
        );
        let response = app
            .merge(raw)
            .oneshot(
                HttpRequest::builder()
                    .uri("/v1/info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let _ = response.into_body().collect().await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn checkpoint_migration_preserves_submitted_jobs_and_resets_interrupted_proofs() {
        let dir = directory();
        let file = dir.join("jobs.json");
        let attempt = Attempt {
            session_id: B256::repeat_byte(1),
            entry_tx_hash: B256::repeat_byte(2),
            player: Address::repeat_byte(1),
            chart_hash: B256::repeat_byte(3),
            day_id: 1,
            web_beatmap_hash: "abc".into(),
            capture_mode: "hardware".into(),
        };
        let start = Started {
            attempt: attempt.clone(),
            job_id: Some("old-job".into()),
        };
        let mut job = Job {
            status: "submitting".into(),
            session_id: attempt.session_id,
            transaction_hash: Some(B256::repeat_byte(9)),
            message: None,
            retryable: false,
        };
        std::fs::write(
            &file,
            json!({"starts":[[attempt.session_id,start]],"jobs":[["old-job",job]]}).to_string(),
        )
        .unwrap();
        let store = Store::load(&file).unwrap();
        assert_eq!(store.jobs["old-job"].transaction_hash, job.transaction_hash);
        store.save(&file).unwrap();
        assert_eq!(Store::load(&file).unwrap().jobs.len(), 1);
        job.transaction_hash = None;
        job.status = "proving".into();
        std::fs::write(
            &file,
            json!({"starts":[[attempt.session_id,start]],"jobs":[["old-job",job]]}).to_string(),
        )
        .unwrap();
        let store = Store::load(&file).unwrap();
        assert!(store.jobs.is_empty());
        assert!(store.starts[&attempt.session_id].job_id.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
