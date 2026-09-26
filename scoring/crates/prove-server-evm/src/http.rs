//! Raw proof HTTP API. Shares its prover and semaphore with paid competition routes.
//!
//! | Request | Response |
//! |---|---|
//! | `GET /healthz` | `{"status":"ok"}` |
//! | `GET /v1/info` | proof system, verifier key id, modes |
//! | `POST /v1/prove` `{"mode": …, "input": PlayInput}` | the proof as JSON |
//!
//! Errors are `{"error": "..."}`: 401 bad/missing token, 422 unknown mode or invalid play,
//! 503 another proof is running, 500 proving failed.
use anyhow::Result;
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use mania_scoring_core::{evaluate, sha256, PlayInput};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{oneshot, Semaphore};

pub const BODY_LIMIT: usize = 16 * 1024 * 1024;

/// A proof system held in memory for the life of the server.
pub trait Prove: Send + Sync + 'static {
    /// `GET /v1/info` body.
    fn info(&self) -> Value;
    fn modes(&self) -> &'static [&'static str];
    /// Prove a play that already passed native scoring. Blocking; runs on its own OS thread.
    fn prove(&self, mode: &str, input: &PlayInput) -> Result<Value>;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProveRequest {
    mode: String,
    input: PlayInput,
}

struct Shared {
    prover: Arc<dyn Prove>,
    busy: Arc<Semaphore>,
    token_hash: Option<[u8; 32]>,
}

fn error(code: StatusCode, text: impl std::fmt::Display) -> Response {
    (code, Json(serde_json::json!({"error": text.to_string()}))).into_response()
}

#[cfg(test)]
pub fn router(prover: Arc<dyn Prove>, token: Option<String>) -> Router {
    router_with_busy(prover, token, Arc::new(Semaphore::new(1)))
}

pub fn router_with_busy(prover: Arc<dyn Prove>, token: Option<String>, busy: Arc<Semaphore>) -> Router {
    let shared = Arc::new(Shared {
        prover,
        busy,
        token_hash: token.map(|t| sha256(t.as_bytes())),
    });
    Router::new()
        .route("/v1/info", get(|State(s): State<Arc<Shared>>| async move { Json(s.prover.info()) }))
        .route("/v1/prove", post(prove))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(shared.clone(), authorize))
        .route("/healthz", get(|| async { Json(serde_json::json!({"status": "ok"})) }))
        .with_state(shared)
}

/// Serve until SIGINT/SIGTERM. A proof still running is not awaited.
pub async fn serve(listener: tokio::net::TcpListener, router: Router) -> Result<()> {
    let stop = async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    };
    tokio::select! {
        result = axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()) => result?,
        _ = stop => eprintln!("prove server stopping"),
    }
    Ok(())
}

async fn authorize(State(s): State<Arc<Shared>>, request: Request, next: Next) -> Response {
    if let Some(expected) = s.token_hash {
        // Compare digests, so the comparison time says nothing about the token.
        let valid = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .is_some_and(|t| sha256(t.as_bytes()) == expected);
        if !valid {
            return error(StatusCode::UNAUTHORIZED, "bearer token required");
        }
    }
    next.run(request).await
}

async fn prove(State(s): State<Arc<Shared>>, Json(request): Json<ProveRequest>) -> Response {
    let modes = s.prover.modes();
    if !modes.contains(&request.mode.as_str()) {
        let text = format!("unsupported mode; expected one of {}", modes.join(", "));
        return error(StatusCode::UNPROCESSABLE_ENTITY, text);
    }
    let ProveRequest { mode, input } = request;
    let checked = tokio::task::spawn_blocking(move || evaluate(&input).map(|_| input)).await;
    let input = match checked {
        Ok(Ok(input)) => input,
        Ok(Err(e)) => return error(StatusCode::UNPROCESSABLE_ENTITY, e),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let Ok(permit) = s.busy.clone().try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "another proof is running; retry later");
    };
    // A dedicated OS thread for the whole proof. The permit lives until proving really ends,
    // even if the client disconnects, so proofs never overlap.
    let prover = s.prover.clone();
    let (tx, rx) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("prove".into())
        .spawn(move || {
            let result = prover.prove(&mode, &input);
            drop(permit);
            let _ = tx.send(result);
        });
    if let Err(e) = spawned {
        return error(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    match rx.await {
        Ok(Ok(proof)) => Json(proof).into_response(),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "prover thread panicked"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tower::ServiceExt;

    const TOKEN: &str = "test-token-at-least-thirty-two-characters";

    /// HTTP-layer test double; real proving is tested in `prover.rs`.
    struct Fake {
        hold: AtomicBool,
    }
    impl Prove for Fake {
        fn info(&self) -> Value {
            serde_json::json!({"system": "fake"})
        }
        fn modes(&self) -> &'static [&'static str] {
            &["fast"]
        }
        fn prove(&self, mode: &str, input: &PlayInput) -> Result<Value> {
            while self.hold.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            anyhow::ensure!(mode == "fast");
            let score = evaluate(input).map_err(anyhow::Error::msg)?.score;
            Ok(serde_json::json!({"score": score}))
        }
    }

    fn body(mode: &str) -> Value {
        let input: Value =
            serde_json::from_str(include_str!("../../../fixtures/perfect.json")).unwrap();
        serde_json::json!({"mode": mode, "input": input})
    }

    async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>, token: bool) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
        }
        let body = Body::from(body.map(|b| b.to_string()).unwrap_or_default());
        let response = app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn prove_returns_json_and_rejects_bad_requests() {
        let app = router(Arc::new(Fake { hold: AtomicBool::new(false) }), Some(TOKEN.into()));
        assert_eq!(call(&app, "GET", "/healthz", None, false).await.0, StatusCode::OK);
        assert_eq!(call(&app, "GET", "/v1/info", None, false).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app, "GET", "/v1/info", None, true).await.1["system"], "fake");
        assert_eq!(call(&app, "POST", "/v1/prove", Some(body("fast")), false).await.0, StatusCode::UNAUTHORIZED);
        let (status, proof) = call(&app, "POST", "/v1/prove", Some(body("fast")), true).await;
        assert_eq!((status, proof["score"].clone()), (StatusCode::OK, 1_000_000.into()));
        let (status, reply) = call(&app, "POST", "/v1/prove", Some(body("slow")), true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(reply["error"].as_str().unwrap().contains("fast"));
        let mut invalid = body("fast");
        invalid["input"]["events"][0]["timestamp_us"] = 1.into();
        assert_eq!(call(&app, "POST", "/v1/prove", Some(invalid), true).await.0, StatusCode::UNPROCESSABLE_ENTITY);
        let mut extra = body("fast");
        extra["unexpected"] = true.into();
        assert!(call(&app, "POST", "/v1/prove", Some(extra), true).await.0.is_client_error());
    }

    #[tokio::test]
    async fn one_proof_at_a_time() {
        let fake = Arc::new(Fake { hold: AtomicBool::new(true) });
        let app = router(fake.clone(), None);
        let first = tokio::spawn({
            let app = app.clone();
            async move { call(&app, "POST", "/v1/prove", Some(body("fast")), false).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (status, _) = call(&app, "POST", "/v1/prove", Some(body("fast")), false).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        fake.hold.store(false, Ordering::SeqCst);
        assert_eq!(first.await.unwrap().0, StatusCode::OK);
        assert_eq!(call(&app, "POST", "/v1/prove", Some(body("fast")), false).await.0, StatusCode::OK);
    }
}
