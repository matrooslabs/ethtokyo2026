//! Local, read-only-chain paid Mode B proving API. The browser owns capture and signing transactions.
use crate::{
    capture::{self, Capture, ParsedChart},
    chain::{self, Chain, Manifest},
    http::Prove,
};
use alloy::primitives::{Address, B256};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{header, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    manifest: PathBuf,
    rpc_url: String,
    allowed_origins: Vec<String>,
    confirmations: u64,
    proving_buffer_seconds: u64,
    proving_buffer_measured: bool,
    charts: Vec<ChartConfig>,
    job_store_file: PathBuf,
    hardware_srs: HardwareSrs,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HardwareSrs {
    bank_hash: B256,
    bank_length: usize,
    max_events: u32,
    srs_id: B256,
    development_only: bool,
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
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    session_id: B256,
    entry_tx_hash: B256,
    player: Address,
    chart_hash: B256,
    day_id: u64,
    web_beatmap_hash: String,
    capture_mode: String,
    chain_id: u64,
    registry: Address,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    status: String,
    session_id: B256,
    capture: Capture,
    result: Option<Value>,
    message: Option<String>,
}
#[derive(Default, Deserialize, Serialize)]
struct Store {
    version: u8,
    starts: BTreeMap<B256, Attempt>,
    jobs: BTreeMap<String, Job>,
}
impl Store {
    fn load(path: &FsPath) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                version: 2,
                ..Self::default()
            });
        }
        let mut s: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            s.version == 2,
            "use a new Mode B job store; preserve legacy relay jobs"
        );
        for j in s.jobs.values_mut() {
            if j.status == "queued" || j.status == "proving" {
                j.status = "failed".into();
                j.message = Some("Prover restarted; retry identical capture".into());
            }
        }
        Ok(s)
    }
    fn save(&self, path: &FsPath) -> Result<()> {
        use std::io::Write;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec(self)?)?;
        f.sync_all()?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}
pub struct Competition {
    cfg: Config,
    chain: Chain,
    charts: BTreeMap<String, GameChart>,
    prover: Arc<dyn Prove>,
    busy: Arc<Semaphore>,
    jobs: Mutex<Store>,
    job_path: PathBuf,
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
        ensure!(bind.ip().is_loopback(), "paid API is loopback only");
        let cfg: Config = serde_json::from_slice(&std::fs::read(file)?)?;
        ensure!(
            cfg.confirmations > 0 && cfg.confirmations <= 10000,
            "invalid confirmations"
        );
        for o in &cfg.allowed_origins {
            let u = reqwest::Url::parse(o)?;
            ensure!(
                ["http", "https"].contains(&u.scheme())
                    && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                    && u.origin().ascii_serialization() == *o,
                "only exact loopback origins supported"
            );
        }
        let manifest: Manifest = serde_json::from_slice(&std::fs::read(root.join(&cfg.manifest))?)?;
        let h = &cfg.hardware_srs;
        ensure!(
            h.srs_id == manifest.srs_id
                && prover.info()["srsId"]
                    .as_str()
                    .context("missing SRS")?
                    .parse::<B256>()?
                    == h.srs_id,
            "SRS ID mismatch"
        );
        ensure!(
            h.max_events > 0 && h.max_events <= 50000 && h.bank_length == h.max_events as usize * 4,
            "invalid hardware bank capacity"
        );
        ensure!(
            h.max_events != 65 || h.development_only,
            "65-event bank is development only"
        );
        ensure!(
            B256::from(prover.bank_hash(h.bank_length)?) == h.bank_hash,
            "pinned G1 bank hash mismatch"
        );
        let mut charts = BTreeMap::new();
        for c in &cfg.charts {
            let parsed = capture::parse_osu(&std::fs::read(root.join(&c.osu_file))?)?;
            ensure!(
                B256::from(mania_scoring_core::chart_hash(&parsed.chart)) == c.chart_hash,
                "chart mismatch"
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
        let job_path = root.join(&cfg.job_store_file);
        let jobs = Store::load(&job_path)?;
        ensure!(
            jobs.starts
                .values()
                .all(|a| a.chain_id == manifest.chain_id
                    && a.registry == manifest.contracts.registry),
            "job store belongs to another deployment"
        );
        ensure!(
            jobs.jobs.values().all(|j| j
                .result
                .as_ref()
                .is_none_or(|r| r["srsId"] == json!(manifest.srs_id))),
            "job store belongs to another SRS"
        );
        jobs.save(&job_path)?;
        let chain = Chain::new(&cfg.rpc_url, manifest, cfg.confirmations)?;
        Ok(Arc::new(Self {
            cfg,
            chain,
            charts,
            prover,
            busy,
            jobs: Mutex::new(jobs),
            job_path,
            bind,
        }))
    }
    async fn ready(&self, c: &GameChart) -> Result<()> {
        ensure!(
            self.cfg.proving_buffer_measured && self.cfg.proving_buffer_seconds > 0,
            "measure end-to-end submission buffer first"
        );
        self.chain.wiring().await?;
        self.chain.ready_chart(c.hash, c.device).await
    }
    async fn bound(&self, a: &Attempt) -> Result<chain::Session> {
        ensure!(
            a.capture_mode == "hardware"
                && a.chain_id == self.chain.manifest.chain_id
                && a.registry == self.chain.manifest.contracts.registry,
            "Mode B deployment mismatch"
        );
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
}
fn failure(status: StatusCode, e: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error":e.to_string()}))).into_response()
}
async fn chart(State(s): State<Arc<Competition>>, Path(hash): Path<String>) -> Response {
    let Some(c) = s.charts.get(&hash) else {
        return failure(StatusCode::NOT_FOUND, "unsupported chart");
    };
    let ready = s.ready(c).await;
    Json(json!({"chartHash":c.hash,"webBeatmapHash":hash,"device":c.device,"durationSeconds":(c.parsed.max_end+136500).div_ceil(1_000_000),"maxEnd":c.parsed.max_end,"provingBufferSeconds":s.cfg.proving_buffer_seconds,"chainId":s.chain.manifest.chain_id,"registry":s.chain.manifest.contracts.registry,"leaderboard":s.chain.manifest.contracts.board,"captureMode":"hardware","mode":2,"hardwareSrs":s.cfg.hardware_srs,"ready":ready.is_ok(),"reason":ready.err().map(|e|e.to_string())})).into_response()
}
async fn start(
    State(s): State<Arc<Competition>>,
    Path(id): Path<B256>,
    Json(a): Json<Attempt>,
) -> Response {
    async fn run(s: &Competition, id: B256, a: Attempt) -> Result<Value> {
        ensure!(id == a.session_id, "session mismatch");
        let c = s
            .charts
            .get(&a.web_beatmap_hash)
            .context("unsupported chart")?;
        ensure!(a.chart_hash == c.hash, "chart mismatch");
        s.ready(c).await?;
        let session = s.bound(&a).await?;
        ensure!(session.header.device == c.device, "device mismatch");
        let mut store = s.jobs.lock().await;
        if let Some(old) = store.starts.get(&id) {
            ensure!(old == &a, "conflicting attempt");
        } else {
            store.starts.insert(id, a);
            store.save(&s.job_path)?;
        }
        Ok(
            json!({"sessionId":id,"captureMode":"hardware","header":format!("0x{}",hex::encode(capture::packed_header(&session.header.core())))}),
        )
    }
    match run(&s, id, a).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => failure(StatusCode::BAD_REQUEST, e),
    }
}
async fn proof(
    State(s): State<Arc<Competition>>,
    Path(id): Path<B256>,
    Json(body): Json<Capture>,
) -> Response {
    async fn run(s: Arc<Competition>, id: B256, body: Capture) -> Result<String> {
        let a = s
            .jobs
            .lock()
            .await
            .starts
            .get(&id)
            .cloned()
            .context("start session first")?;
        ensure!(
            body.web_beatmap_hash == a.web_beatmap_hash,
            "chart mismatch"
        );
        let key = id.to_string();
        {
            let store = s.jobs.lock().await;
            if let Some(j) = store.jobs.get(&key) {
                ensure!(j.capture == body, "conflicting capture for session");
                if j.status != "failed" {
                    return Ok(key);
                }
            }
        }
        let session = s.bound(&a).await?;
        let c = &s.charts[&a.web_beatmap_hash];
        let (input, commitment, signature, digest) = body.decode(
            &session.header.core(),
            &c.parsed,
            s.cfg.hardware_srs.max_events,
        )?;
        let permit = s
            .busy
            .clone()
            .try_acquire_owned()
            .context("prover busy; retry shortly")?;
        {
            let mut store = s.jobs.lock().await;
            if let Some(j) = store.jobs.get(&key) {
                ensure!(j.capture == body, "conflicting capture");
                if j.status != "failed" {
                    return Ok(key);
                }
            }
            store.jobs.insert(
                key.clone(),
                Job {
                    status: "queued".into(),
                    session_id: id,
                    capture: body,
                    result: None,
                    message: None,
                },
            );
            store.save(&s.job_path)?;
        }
        let job_key = key.clone();
        tokio::spawn(async move {
            let result:Result<Value>=async {
                {let mut store=s.jobs.lock().await;store.jobs.get_mut(&job_key).unwrap().status="proving".into();store.save(&s.job_path)?;}
                let prover=s.prover.clone();let play=input.clone();
                let proof=tokio::task::spawn_blocking(move ||{let _permit=permit;prover.prove_sealed(&play,commitment)}).await??;
                ensure!(proof["sessionDigest"].as_str().context("missing digest")?.parse::<B256>()?==digest,"proof digest mismatch");
                s.bound(&a).await?;
                Ok(json!({"chainId":a.chain_id,"registry":a.registry,"sessionId":id,"srsId":s.cfg.hardware_srs.srs_id,"sessionDigest":digest,"submission":{"sessionId":id,"eventCount":input.footer.event_count,"root":B256::from(input.footer.trace_root),"commitment":proof["traceCommitment"],"duration":input.footer.duration_us.to_string(),"laneBits":proof["laneBits"],"counts":proof["counts"],"proof":proof["proof"],"signature":format!("0x{}",hex::encode(signature))},"timings":proof["timings"]}))
            }.await;
            let mut store = s.jobs.lock().await;
            let j = store.jobs.get_mut(&job_key).unwrap();
            match result {
                Ok(v) => {
                    j.status = "ready".into();
                    j.result = Some(v);
                    j.message = None
                }
                Err(e) => {
                    j.status = "failed".into();
                    j.message = Some(e.to_string())
                }
            }
            if let Err(e) = store.save(&s.job_path) {
                eprintln!("cannot persist proof: {e}");
            }
        });
        Ok(key)
    }
    match run(s, id, body).await {
        Ok(id) => (StatusCode::ACCEPTED, Json(json!({"jobId":id}))).into_response(),
        Err(e) => failure(StatusCode::BAD_REQUEST, e),
    }
}
async fn job(State(s): State<Arc<Competition>>, Path(id): Path<String>) -> Response {
    match s.jobs.lock().await.jobs.get(&id){Some(j)=>Json(json!({"status":j.status,"sessionId":j.session_id,"result":j.result,"message":j.message})).into_response(),None=>failure(StatusCode::NOT_FOUND,"unknown job")}
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
    #[test]
    fn restart_preserves_original_capture_and_ready_results_but_never_imports_mode_a_jobs() {
        let path = std::env::temp_dir().join(format!("mode-b-store-{}.json", std::process::id()));
        let mut store = Store {
            version: 2,
            ..Store::default()
        };
        let capture = Capture {
            result: "0xoriginal".into(),
            trace: "0xtrace".into(),
            web_beatmap_hash: "chart".into(),
        };
        store.jobs.insert(
            "interrupted".into(),
            Job {
                status: "proving".into(),
                session_id: B256::ZERO,
                capture: capture.clone(),
                result: None,
                message: None,
            },
        );
        store.jobs.insert(
            "ready".into(),
            Job {
                status: "ready".into(),
                session_id: B256::ZERO,
                capture: capture.clone(),
                result: Some(json!({"submission":"immutable proof"})),
                message: None,
            },
        );
        store.save(&path).unwrap();
        let loaded = Store::load(&path).unwrap();
        assert_eq!(loaded.jobs["interrupted"].status, "failed");
        assert!(loaded.jobs["interrupted"].capture == capture);
        assert_eq!(loaded.jobs["ready"].result, store.jobs["ready"].result);
        std::fs::write(&path, r#"{"starts":[],"jobs":[]}"#).unwrap();
        assert!(Store::load(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
