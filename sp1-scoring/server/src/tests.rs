use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use tower::ServiceExt;

const TOKEN: &str = "test-token-at-least-thirty-two-characters";
const KEY: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";

/// Explicit application test double; real proof generation is checked by the HTTP smoke test.
struct TestBackend {
    active: AtomicUsize,
    maximum: AtomicUsize,
    started: tokio::sync::Notify,
    gate: Semaphore,
    fail: bool,
    corrupt: bool,
    groth16: bool,
}
impl TestBackend {
    fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
            started: tokio::sync::Notify::new(),
            gate: Semaphore::new(0),
            fail: false,
            corrupt: false,
            groth16: false,
        }
    }
}

#[async_trait]
impl Backend for TestBackend {
    fn vkey(&self) -> &str {
        KEY
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
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        self.started.notify_one();
        tokio::select! {
            permit = self.gate.acquire() => { permit?.forget(); }
            _ = stop.cancelled() => { self.active.fetch_sub(1, Ordering::SeqCst); anyhow::bail!("server shutting down"); }
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        // These bytes are deliberately not a valid proof. Only this injected backend uses them.
        fs::write(dir.join("proof.bin"), b"TEST ONLY")?;
        if self.fail {
            anyhow::bail!("test prover failed");
        }
        let play: PlayInput = serde_json::from_slice(&fs::read(input)?)?;
        let mut result = evaluate(&play).unwrap();
        if self.corrupt {
            result.score -= 1;
        }
        write_json(
            &dir.join("proof.json"),
            &serde_json::json!({
                "mode": mode, "vkey": KEY,
                "publicValues": format!("0x{}", hex::encode(result.abi_encode())),
                "proof": if mode == Mode::Core { None } else { Some("0x0102030405") },
                "proofGenerated": true, "locallyVerified": true, "result": result,
            }),
        )?;
        Ok(())
    }
}

fn fixture() -> serde_json::Value {
    serde_json::json!({"mode": "core", "input": serde_json::from_str::<serde_json::Value>(include_str!("../../fixtures/perfect.json")).unwrap()})
}

async fn request(
    app: &Arc<App>,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
    token: bool,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(url)
        .header(header::CONTENT_TYPE, "application/json");
    if token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    }
    router(app.clone())
        .oneshot(
            request
                .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn json(response: Response) -> serde_json::Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn submit(app: &Arc<App>) -> Uuid {
    let response = request(app, "POST", "/v1/proofs", Some(fixture()), true).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    Uuid::parse_str(json(response).await["id"].as_str().unwrap()).unwrap()
}

async fn wait(app: &Arc<App>, id: Uuid) -> Job {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let job = app.jobs.lock().await[&id].clone();
            if job.status.terminal() {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

async fn close(app: Arc<App>, worker: tokio::task::JoinHandle<()>) {
    app.stop.cancel();
    worker.await.unwrap();
    app.stop_pending().await.unwrap();
}

#[tokio::test]
async fn authenticated_job_lifecycle_download_delete_and_retention() {
    let root = tempfile::tempdir().unwrap();
    let backend = Arc::new(TestBackend::new());
    let (app, worker) = App::open(root.path(), backend.clone(), Some(TOKEN.into()), 2, 1).unwrap();
    assert_eq!(
        request(&app, "GET", "/healthz", None, false).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(fixture()), false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let id = submit(&app).await;
    backend.started.notified().await;
    let url = format!("/v1/proofs/{id}");
    assert_eq!(
        request(&app, "GET", &format!("{url}/proof.bin"), None, true)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, "DELETE", &url, None, true).await.status(),
        StatusCode::CONFLICT
    );
    backend.gate.add_permits(1);
    let job = wait(&app, id).await;
    assert_eq!(job.status, Status::Succeeded);
    assert_eq!(job.score, Some(1_000_000));
    let proof = request(&app, "GET", &format!("{url}/proof.json"), None, true).await;
    assert_eq!(proof.status(), StatusCode::OK);
    assert_eq!(json(proof).await["result"]["score"], 1_000_000);
    assert_eq!(
        request(&app, "GET", &format!("{url}/proof.bin"), None, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "GET", &format!("{url}/input.json"), None, true)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(fixture()), true)
            .await
            .status(),
        StatusCode::INSUFFICIENT_STORAGE
    );
    assert_eq!(
        request(&app, "DELETE", &url, None, true).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, "GET", &url, None, true).await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(!root.path().join(id.to_string()).exists());
    close(app, worker).await;
}

#[tokio::test]
async fn bounded_queue_and_single_prover() {
    let root = tempfile::tempdir().unwrap();
    let backend = Arc::new(TestBackend::new());
    let (app, worker) = App::open(root.path(), backend.clone(), None, 1, 10).unwrap();
    let first = submit(&app).await;
    backend.started.notified().await;
    let second = submit(&app).await;
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(fixture()), true)
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    backend.gate.add_permits(2);
    assert_eq!(wait(&app, first).await.status, Status::Succeeded);
    assert_eq!(wait(&app, second).await.status, Status::Succeeded);
    assert_eq!(backend.maximum.load(Ordering::SeqCst), 1);
    close(app, worker).await;
}

#[tokio::test]
async fn reject_bad_witness_unsupported_mode_and_large_body() {
    let root = tempfile::tempdir().unwrap();
    let (app, worker) = App::open(root.path(), Arc::new(TestBackend::new()), None, 2, 10).unwrap();
    let mut invalid = fixture();
    invalid["input"]["events"][0]["timestamp_us"] = 1.into();
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(invalid), true)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut unsupported = fixture();
    unsupported["mode"] = "mock".into();
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(unsupported), true)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut groth = fixture();
    groth["mode"] = "groth16".into();
    assert_eq!(
        request(&app, "POST", "/v1/proofs", Some(groth), true)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let request = Request::builder()
        .method("POST")
        .uri("/v1/proofs")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(vec![b' '; BODY_LIMIT + 1]))
        .unwrap();
    assert_eq!(
        router(app.clone()).oneshot(request).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(app.jobs.lock().await.is_empty());
    close(app, worker).await;
}

#[tokio::test]
async fn failed_or_mismatched_output_is_never_downloadable() {
    for corrupt in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut backend = TestBackend::new();
        backend.fail = !corrupt;
        backend.corrupt = corrupt;
        backend.gate.add_permits(1);
        let (app, worker) = App::open(root.path(), Arc::new(backend), None, 2, 10).unwrap();
        let id = submit(&app).await;
        assert_eq!(wait(&app, id).await.status, Status::Failed);
        assert!(!root.path().join(id.to_string()).join("proof.bin").exists());
        assert_eq!(
            request(
                &app,
                "GET",
                &format!("/v1/proofs/{id}/proof.json"),
                None,
                true
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        close(app, worker).await;
    }
}

#[tokio::test]
async fn recovered_jobs_locks_and_guest_version_are_checked() {
    let root = tempfile::tempdir().unwrap();
    let backend = Arc::new(TestBackend::new());
    let (app, worker) = App::open(root.path(), backend.clone(), None, 2, 10).unwrap();
    assert!(App::open(root.path(), backend.clone(), None, 2, 10).is_err());
    let id = submit(&app).await;
    backend.started.notified().await;
    close(app, worker).await;
    let path = root.path().join(id.to_string()).join("job.json");
    let mut interrupted: Job = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    interrupted.status = Status::Running;
    write_json(&path, &interrupted).unwrap();
    let (app, worker) = App::open(root.path(), backend.clone(), None, 2, 10).unwrap();
    assert_eq!(app.jobs.lock().await[&id].status, Status::Failed);
    assert!(app.jobs.lock().await[&id]
        .error
        .as_ref()
        .unwrap()
        .contains("restarted"));
    close(app, worker).await;
    write_json(
        &root.path().join("server.json"),
        &serde_json::json!({"vkey":"other"}),
    )
    .unwrap();
    assert!(App::open(root.path(), backend, None, 2, 10).is_err());
}

#[tokio::test]
async fn completed_groth16_artifacts_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut backend = TestBackend::new();
    backend.groth16 = true;
    backend.gate.add_permits(1);
    let backend = Arc::new(backend);
    let (app, worker) = App::open(root.path(), backend.clone(), Some(TOKEN.into()), 2, 10).unwrap();
    let mut body = fixture();
    body["mode"] = "groth16".into();
    let response = request(&app, "POST", "/v1/proofs", Some(body), true).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let id = Uuid::parse_str(json(response).await["id"].as_str().unwrap()).unwrap();
    assert_eq!(wait(&app, id).await.status, Status::Succeeded);
    close(app, worker).await;
    let (app, worker) = App::open(root.path(), backend, Some(TOKEN.into()), 2, 10).unwrap();
    let metadata = json(request(&app, "GET", "/v1/meta", None, true).await).await;
    assert_eq!(metadata["modes"], serde_json::json!(["core", "groth16"]));
    let proof = json(
        request(
            &app,
            "GET",
            &format!("/v1/proofs/{id}/proof.json"),
            None,
            true,
        )
        .await,
    )
    .await;
    assert_eq!(proof["mode"], "groth16");
    assert_eq!(proof["proof"], "0x0102030405");
    let binary = request(
        &app,
        "GET",
        &format!("/v1/proofs/{id}/proof.bin"),
        None,
        true,
    )
    .await;
    assert_eq!(binary.status(), StatusCode::OK);
    assert_eq!(
        &binary.into_body().collect().await.unwrap().to_bytes()[..],
        b"TEST ONLY"
    );
    close(app, worker).await;
}

#[tokio::test]
async fn process_timeout_and_shutdown_are_enforced() {
    let root = tempfile::tempdir().unwrap();
    let stop = CancellationToken::new();
    let result = process::run(
        Path::new("/bin/sh"),
        &["-c", "printf hello; sleep 10"],
        Duration::from_millis(100),
        &stop,
        Some(&root.path().join("log")),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("timeout"));
    assert!(fs::read_to_string(root.path().join("log"))
        .unwrap()
        .contains("hello"));
    stop.cancel();
    let result = process::run(
        Path::new("/bin/sh"),
        &["-c", "sleep 10"],
        Duration::from_secs(20),
        &stop,
        None,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("shutting down"));
}
