//! Hardware-sealed Sui session bridge. The only scoring path accepts the bytes returned
//! by BridgeOS GET_RESULT/GET_TRACE, never a browser-generated PlayInput or signature.
use anyhow::{bail, ensure, Context, Result};
use axum::{extract::{Path, State}, http::StatusCode, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use mania_gkr_sui::{field::{g1_to_bytes, hex0x}, scoring::{api, encode, session::register_chart}, transcript::keccak, zeromorph::{Srs, VerifierKey}};
use mania_scoring_core::{chart_hash, ruleset_id, sha256, trace_root, Chart, InputEvent, PlayInput, SessionFooter, SessionHeader, MAX_EVENTS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use tokio::sync::Semaphore;

const POLICY: &[u8] = b"OSUMANIA_INPUT_POLICY_V2_KZG";
const DOMAIN: &[u8] = b"OSUMANIA_HARDWARE_SESSION_V2";
const RESULT_SIZE: usize = 465;
const HEADER_SIZE: usize = 292;
const INFO_SIZE: usize = 128;
// Mode 3 stages timestamps as Move scalars and lane/action bytes in a 250 KiB
// TraceUpload. The device accepts 50k events, but that object does not.
const MAX_SUI_HARDWARE_EVENTS: usize = 7_000;

pub struct Bridge {
    pub srs: Srs,
    pub vk: VerifierKey,
    pub srs_id: [u8; 32],
    pub rpc: String,
    pub grpc_network: Option<String>,
    pub registry: String,
    pub package: String,
    pub jobs: PathBuf,
    pub client: Option<reqwest::Client>,
    pub busy: Arc<Semaphore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start { session_id: String, info_hex: String, status_hex: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture { session_id: String, result_hex: String, trace_hex: String, chart: Chart }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJob { state: String, session_id: String, capture: Option<Capture>, payload: Option<Value>, error: Option<String> }

fn err(code: StatusCode, e: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": e.to_string()}))).into_response()
}
fn parse_hex(text: &str, len: usize) -> Result<Vec<u8>> {
    let bytes = hex::decode(text.strip_prefix("0x").unwrap_or(text))?;
    ensure!(bytes.len() == len, "expected {len} bytes");
    Ok(bytes)
}
fn hex_field<const N: usize>(text: &str) -> Result<[u8; N]> {
    Ok(parse_hex(text, N)?.try_into().unwrap())
}
fn bytes(v: &Value, len: usize) -> Result<Vec<u8>> {
    let b = if let Some(text) = v.as_str() {
        hex::decode(text.strip_prefix("0x").unwrap_or(text))?
    } else if let Some(a) = v.as_array() {
        a.iter().map(|x| x.as_u64().filter(|n| *n < 256).map(|n| n as u8).context("invalid byte"))
            .collect::<Result<Vec<_>>>()?
    } else { bail!("missing byte vector") };
    ensure!(b.len() == len, "expected {len} bytes in on-chain object");
    Ok(b)
}
fn num(v: &Value) -> Result<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).context("invalid on-chain integer")
}
fn fields(v: &Value) -> Result<&Value> { v.get("fields").context("missing on-chain object fields") }
fn id(text: &str) -> Result<String> { Ok(format!("0x{}", hex::encode(hex_field::<32>(text)?))) }
fn normalized_type_id(text: &str) -> Result<String> {
    let digits = text.strip_prefix("0x").context("invalid Move package ID")?;
    ensure!(!digits.is_empty() && digits.len() <= 64 && digits.bytes().all(|c| c.is_ascii_hexdigit()), "invalid Move package ID");
    Ok(format!("0x{digits:0>64}").to_ascii_lowercase())
}

impl Bridge {
    pub fn new(srs: Srs, rpc: String, registry: String, package: String, jobs: PathBuf) -> Result<Self> {
        ensure!(rpc.starts_with("https://") || rpc.starts_with("http://127.0.0.1:") || rpc.starts_with("http://localhost:"), "Sui RPC must use HTTPS or loopback");
        // Public Sui fullnodes retired JSON-RPC. Loopback JSON-RPC remains useful for
        // localnet; HTTPS always uses the pinned Sui SDK's supported gRPC transport.
        let grpc_network = if rpc.starts_with("https://") {
            Some(std::env::var("SUI_NETWORK").context("SUI_NETWORK (testnet/mainnet/devnet) required for public Sui gRPC")?)
        } else { None };
        let (registry, package) = (id(&registry)?, id(&package)?);
        fs::create_dir_all(&jobs)?;
        let vk = srs.vk();
        let srs_id = vk.id();
        let client = grpc_network.is_none().then(reqwest::Client::new);
        Ok(Self { srs, vk, srs_id, rpc, grpc_network, registry, package, jobs,
            client, busy: Arc::new(Semaphore::new(1)) })
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let response = self.client.as_ref().context("JSON-RPC restricted to loopback localnet")?.post(&self.rpc)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send().await?.error_for_status()?.json::<Value>().await?;
        ensure!(response.get("error").is_none(), "Sui RPC {method}: {}", response["error"]);
        response.get("result").cloned().context("Sui RPC returned no result")
    }
    async fn grpc_snapshot(&self, sid: &str) -> Result<Value> {
        let (rpc, network, sid, registry, package) = (
            self.rpc.clone(), self.grpc_network.as_deref().context("gRPC network not configured")?.to_string(),
            sid.to_string(), self.registry.clone(), self.package.clone(),
        );
        let helper = std::env::var("SUI_GRPC_HELPER").map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sui_grpc.mjs"));
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new("node").arg(helper).args([rpc, network, sid, registry, package]).output()
        }).await??;
        ensure!(output.status.success(), "Sui gRPC read failed: {}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).context("invalid Sui gRPC read response")
    }
    async fn object(&self, object_id: &str, expected_type: &str) -> Result<Value> {
        let result = self.rpc("sui_getObject", json!([object_id, {"showContent":true}])).await?;
        let data = result.get("data").context("Sui object does not exist")?;
        ensure!(data["content"]["dataType"] == "moveObject", "not a Move object");
        let move_type = data["content"]["type"].as_str().context("missing Move object type")?;
        ensure!(move_type.ends_with(expected_type), "wrong Move object type");
        ensure!(normalized_type_id(move_type.split("::").next().unwrap_or_default())? == self.package, "wrong Move package");
        Ok(fields(&data["content"])?.clone())
    }
    async fn session(&self, sid: &str) -> Result<(SessionHeader, Value)> {
        let sid = id(sid)?;
        let snapshot = if self.grpc_network.is_some() { Some(self.grpc_snapshot(&sid).await?) } else { None };
        let sf = if let Some(s) = &snapshot { s["session"].clone() }
            else { self.object(&sid, "::registry::Session").await? };
        ensure!(id(sf["registry"].as_str().context("missing registry")?)? == self.registry, "session belongs to another registry");
        ensure!(sf["consumed"] == false, "session already consumed");
        ensure!(num(&sf["mode"])? == 3, "session is not hardware calldata mode");
        ensure!(num(&sf["expires_at_ms"])? > SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64, "session expired");
        let h = fields(&sf["header"])?;
        let b = |name: &str, n| bytes(&h[name], n);
        let hdr = SessionHeader {
            chain_id: num(&h["chain_id"])?, verifier: b("verifier", 20)?.try_into().unwrap(),
            match_id: b("match_id", 32)?.try_into().unwrap(), session_id: b("session_id", 32)?.try_into().unwrap(),
            challenge: b("challenge", 32)?.try_into().unwrap(), player: b("player", 20)?.try_into().unwrap(),
            device: b("device", 20)?.try_into().unwrap(), chart_hash: b("chart_hash", 32)?.try_into().unwrap(),
            ruleset_id: b("ruleset_id", 32)?.try_into().unwrap(), bitstream_hash: b("bitstream_hash", 32)?.try_into().unwrap(),
            input_policy_hash: b("input_policy_hash", 32)?.try_into().unwrap(),
        };
        ensure!(hdr.session_id == hex_field::<32>(&sid)?, "session header ID mismatch");
        ensure!(hdr.ruleset_id == ruleset_id() && hdr.input_policy_hash == sha256(POLICY), "unsupported hardware policy or ruleset");
        let reg = if let Some(s) = &snapshot { s["registry"].clone() }
            else { self.object(&self.registry, "::registry::Registry").await? };
        ensure!(num(&reg["chain_id"])? == hdr.chain_id && bytes(&reg["verifier_tag"], 20)? == hdr.verifier, "registry domain mismatch");
        let registry_id = hex_field::<32>(&self.registry)?;
        ensure!(&keccak(&[&registry_id])[12..] == hdr.verifier, "registry verifier tag mismatch");
        let onchain_vk = fields(&reg["vk"])?;
        ensure!(bytes(&onchain_vk["id"], 32)? == self.srs_id, "server SRS differs from on-chain verifier key");
        ensure!(num(&onchain_vk["smax"])? == self.srs.smax as u64, "server SRS size differs from on-chain verifier key");
        // A device MUST be registered and active, not merely self-asserted by GET_INFO.
        let dev = if let Some(s) = &snapshot {
            fields(&s["device"])?.clone()
        } else {
            let device_field = self.rpc("suix_getDynamicFieldObject", json!([
                reg["devices"]["fields"]["id"]["id"].as_str().context("missing device table ID")?,
                {"type":"vector<u8>","value":hdr.device}
            ])).await?;
            fields(&fields(&device_field["data"]["content"])?["value"])?.clone()
        };
        ensure!(dev["active"] == true && bytes(&dev["bitstream_hash"], 32)? == hdr.bitstream_hash, "device not active or bitstream mismatched");
        let pubkey = bytes(&dev["pubkey"], 33)?;
        let vk = VerifyingKey::from_sec1_bytes(&pubkey)?;
        let uncompressed = vk.to_encoded_point(false);
        ensure!(&keccak(&[&uncompressed.as_bytes()[1..]])[12..] == hdr.device, "device public key/address mismatch");
        // The registry stores registered chart commitments in its dynamic table.
        let chart_record = if let Some(s) = &snapshot {
            s["chart"].clone()
        } else {
            let chart_field = self.rpc("suix_getDynamicFieldObject", json!([
                reg["charts"]["fields"]["id"]["id"].as_str().context("missing chart table ID")?,
                {"type":"vector<u8>","value":hdr.chart_hash}
            ])).await?;
            fields(&chart_field["data"]["content"])?["value"].clone()
        };
        Ok((hdr, json!({"pubkey":hex0x(&pubkey), "chart":chart_record})))
    }
    fn job_path(&self, sid: &str) -> Result<PathBuf> { Ok(self.jobs.join(format!("{}.json", hex::encode(hex_field::<32>(sid)?)))) }
    fn save(&self, job: &StoredJob) -> Result<()> {
        let path = self.job_path(&job.session_id)?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(job)?)?;
        fs::rename(tmp, path)?;
        Ok(())
    }
    fn load(&self, sid: &str) -> Result<StoredJob> { Ok(serde_json::from_slice(&fs::read(self.job_path(sid)?)?)?) }
}

fn header_bytes(h: &SessionHeader) -> [u8; HEADER_SIZE] {
    let mut out = [0u8; HEADER_SIZE];
    let mut at = 0;
    for part in [&h.chain_id.to_be_bytes()[..], &h.verifier, &h.match_id, &h.session_id, &h.challenge,
        &h.player, &h.device, &h.chart_hash, &h.ruleset_id, &h.bitstream_hash, &h.input_policy_hash] {
        out[at..at + part.len()].copy_from_slice(part);
        at += part.len();
    }
    out
}

fn parse_capture(h: SessionHeader, capture: &Capture, pubkey: &str) -> Result<(PlayInput, [u8; 32], Vec<u8>, Vec<u8>)> {
    let result = parse_hex(&capture.result_hex, RESULT_SIZE)?;
    ensure!(result[..HEADER_SIZE] == header_bytes(&h), "device result header differs from on-chain Session");
    let n = u32::from_be_bytes(result[292..296].try_into().unwrap()) as usize;
    let duration = u64::from_be_bytes(result[296..304].try_into().unwrap());
    ensure!(n <= MAX_EVENTS && n <= MAX_SUI_HARDWARE_EVENTS,
        "device trace exceeds Sui mode-3 upload limit (7000 events)");
    let trace = parse_hex(&capture.trace_hex, n * 14)?;
    let events: Vec<InputEvent> = trace.chunks_exact(14).map(|e| InputEvent {
        sequence: u32::from_be_bytes(e[..4].try_into().unwrap()),
        timestamp_us: u64::from_be_bytes(e[4..12].try_into().unwrap()), lane: e[12], action: e[13],
    }).collect();
    ensure!(events.iter().enumerate().all(|(i, e)| e.sequence as usize == i), "trace sequence mismatch");
    let root: [u8; 32] = result[304..336].try_into().unwrap();
    ensure!(root == trace_root(&h.session_id, &events), "device trace root mismatch");
    ensure!(chart_hash(&capture.chart) == h.chart_hash, "chart does not match registered session");
    let mut preimage = [0u8; DOMAIN.len() + 2 + 400];
    preimage[..DOMAIN.len()].copy_from_slice(DOMAIN);
    preimage[DOMAIN.len()..DOMAIN.len() + 2].copy_from_slice(&2u16.to_be_bytes());
    preimage[DOMAIN.len() + 2..].copy_from_slice(&result[..400]);
    let digest = sha256(&preimage);
    let signature = Signature::from_slice(&result[400..464])?;
    ensure!(signature.normalize_s().is_none(), "device signature is not low-s");
    let recovery = RecoveryId::from_byte(result[464].checked_sub(27).context("invalid recovery byte")?).context("invalid recovery byte")?;
    let recovered = VerifyingKey::recover_from_prehash(&digest, &signature, recovery)?;
    ensure!(recovered.to_encoded_point(true).as_bytes() == parse_hex(pubkey, 33)?.as_slice(), "hardware signature does not match registry device");
    let input = PlayInput { header: h, footer: SessionFooter { event_count: n as u32, duration_us: duration, trace_root: root }, chart: capture.chart.clone(), events };
    Ok((input, digest, trace, result))
}

async fn start(State(s): State<Arc<Bridge>>, Json(req): Json<Start>) -> Response {
    match async {
        let (h, _) = s.session(&req.session_id).await?;
        let info = parse_hex(&req.info_hex, INFO_SIZE)?;
        let status = parse_hex(&req.status_hex, 16)?;
        ensure!(status[0] == 0 && status[2..] == [0u8; 14], "hardware not idle/ready");
        ensure!(info[..2] == 1u16.to_be_bytes() && info[2..4] == 64u16.to_be_bytes(), "unsupported BridgeOS protocol");
        ensure!(info[8..28] == h.device && info[28..60] == h.bitstream_hash && info[60..92] == h.input_policy_hash,
            "hardware identity, bitstream or input policy mismatch");
        ensure!(u32::from_be_bytes(info[124..128].try_into().unwrap()) > 0, "hardware trace SRS unavailable");
        ensure!(info[92..124] != [0; 32], "hardware trace SRS unavailable");
        Ok::<_, anyhow::Error>(json!({"sessionId":id(&req.session_id)?, "headerHex":hex0x(&header_bytes(&h)), "mode":"hardware-calldata"}))
    }.await { Ok(v) => Json(v).into_response(), Err(e) => err(StatusCode::UNPROCESSABLE_ENTITY, e) }
}

fn relay_payload(s: &Bridge, sid: &str, input: &PlayInput, trace: &[u8], result: &[u8], p: &api::Proved, score: &Value) -> Value {
    let target = |name: &str| format!("{}::registry::{name}", s.package);
    let proof = encode::proof_items(&p.proof);
    let proof_groups = encode::group_items(&proof, mania_gkr_sui::sui::GROUP_BYTES);
    let trace_batches: Vec<Vec<String>> = trace.chunks(14 * 32 * 20)
        .map(|batch| batch.chunks(14 * 32).map(hex0x).collect()).collect();
    json!({
        "kind":"sui-programmable-transaction", "registryId":s.registry, "sessionId":sid,
        "clockId":"0x6", "packageId":s.package,
        "steps":[
            {"target":target("new_trace_upload"), "arguments":[{"object":sid}], "returns":"trace"},
            {"target":target("append_trace"), "repeatFor":"traceBatches", "arguments":[{"result":"trace"},{"pure":"vector<vector<u8>>", "from":"traceBatches[*]"}]},
            {"target":target("submit_hardware"), "arguments":[{"object":s.registry},{"object":sid},{"result":"trace"},
                {"pure":"u64", "value":input.footer.duration_us.to_string()},
                {"pure":"vector<u8>", "value":hex0x(&result[336..400])},
                {"pure":"vector<u64>", "value":p.proof.lane_bits},
                {"pure":"vector<u64>", "value":p.proof.counts},
                {"makeMoveVec":"vector<vector<vector<u8>>>", "from":"proofGroups"},
                {"pure":"vector<u8>", "value":hex0x(&result[400..])}, {"object":"0x6"}]}
        ],
        "traceBatches":trace_batches,
        "proofGroups":proof_groups.iter().map(|group| group.iter().map(|b| hex0x(b)).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "sessionDigest":hex0x(&p.statement.session_digest), "result":score,
        "note":"Relay builds proofGroups as individual pure vector<vector<u8>> PTB inputs, then MakeMoveVec; use original bytes and signature, never sign or rebind the capture. Confirm ScoreAccepted on-chain before crediting the player."
    })
}

async fn run(s: &Bridge, capture: &Capture) -> Result<Value> {
    let (hdr, registration) = s.session(&capture.session_id).await?;
    let (input, digest, trace, result) = parse_capture(hdr, capture, registration["pubkey"].as_str().context("device pubkey missing")?)?;
    // Native witness validation checks all scoring constraints using the unmodified device trace.
    let reg = register_chart(&s.srs, &input.chart)?;
    let onchain = fields(&registration["chart"])?;
    ensure!(bytes(&onchain["commitment"], 48)? == g1_to_bytes(&reg.record.commitment), "chart commitment does not match on-chain registration");
    for (field, actual) in [("m", reg.record.m), ("bits", reg.record.bits), ("components", reg.record.components), ("max_end", reg.record.max_end)] {
        ensure!(num(&onchain[field])? == actual, "on-chain chart {field} mismatch");
    }
    let p = api::prove_sealed_calldata(&s.srs, &input, &reg.record, digest)?;
    let verified = api::verify(&s.vk, &p.statement, &p.proof, Some(&input.events))?;
    Ok(relay_payload(s, &id(&capture.session_id)?, &input, &trace, &result, &p, &json!(verified)))
}

async fn submit(State(s): State<Arc<Bridge>>, Json(capture): Json<Capture>) -> Response {
    let sid = match id(&capture.session_id) { Ok(sid) => sid, Err(e) => return err(StatusCode::BAD_REQUEST, e) };
    if let Ok(job) = s.load(&sid) {
        if job.state == "ready" {
            return Json(json!({"sessionId":sid,"state":"ready","payload":job.payload})).into_response();
        }
    }
    let Ok(permit) = s.busy.clone().try_acquire_owned() else { return err(StatusCode::SERVICE_UNAVAILABLE, "prover busy"); };
    let mut job = StoredJob { state:"proving".into(), session_id:sid.clone(), capture:Some(capture), payload:None, error:None };
    if let Err(e) = s.save(&job) { return err(StatusCode::INTERNAL_SERVER_ERROR, e); }
    let state = s.clone();
    let spawned = std::thread::Builder::new().name("sui-hardware-proof".into()).spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
        let outcome = runtime.map_err(anyhow::Error::from).and_then(|rt| rt.block_on(run(&state, job.capture.as_ref().unwrap())));
        match outcome {
            Ok(payload) => { job.state = "ready".into(); job.payload = Some(payload); }
            Err(e) => { job.state = "failed".into(); job.error = Some(format!("{e:#}")); }
        }
        if let Err(e) = state.save(&job) { eprintln!("failed to persist proof job {}: {e:#}", job.session_id); }
        drop(permit);
    });
    match spawned {
        Ok(_) => (StatusCode::ACCEPTED, Json(json!({"sessionId":sid,"state":"proving","statusUrl":format!("/v1/jobs/{sid}")}))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e)
    }
}
async fn status(State(s): State<Arc<Bridge>>, Path(sid): Path<String>) -> Response {
    match s.load(&sid) {
        Ok(job) => {
            let state = if job.state == "proving" && s.busy.available_permits() != 0 { "interrupted" } else { &job.state };
            Json(json!({"sessionId":job.session_id,"state":state,"payload":job.payload,"error":job.error})).into_response()
        }
        Err(_) => err(StatusCode::NOT_FOUND, "job not found"),
    }
}
async fn retry(State(s): State<Arc<Bridge>>, Path(sid): Path<String>) -> Response {
    match s.load(&sid) {
        Ok(job) if job.state == "ready" => Json(json!({"sessionId":job.session_id,"state":job.state,"payload":job.payload})).into_response(),
        Ok(job) if job.state == "proving" && s.busy.available_permits() == 0 => err(StatusCode::CONFLICT, "proof still running"),
        Ok(job) => match job.capture {
            Some(capture) => submit(State(s), Json(capture)).await,
            None => err(StatusCode::CONFLICT, "capture unavailable"),
        },
        Err(_) => err(StatusCode::NOT_FOUND, "job not found"),
    }
}
pub fn router(state: Arc<Bridge>) -> Router {
    Router::new().route("/v1/sessions/start", post(start))
        .route("/v1/sessions/submit", post(submit))
        .route("/v1/jobs/{session_id}", get(status))
        .route("/v1/jobs/{session_id}/retry", post(retry))
        .with_state(state)
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
