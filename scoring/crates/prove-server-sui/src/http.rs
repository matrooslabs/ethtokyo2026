//! Sui hardware scoring HTTP API. Never accepts a browser-generated PlayInput.
//!
//! `GET /healthz` returns process health (NOT hardware/session readiness).
//! `GET /v1/info` returns GKR SRS identity, registry/package and supported capture protocol.
//! `POST /v1/sessions/start` `{sessionId,infoHex,statusHex}` validates the live Sui
//! Session, registered hardware and BridgeOS readiness; returns `{headerHex}` (292
//! bytes) to send unmodified to HID SET_HEADER, then START and STOP.
//! `POST /v1/sessions/submit` `{sessionId,resultHex,traceHex,chart}` accepts only
//! actual HID GET_RESULT (465 bytes) and GET_TRACE (14 bytes per event), validates
//! original signature, exact on-chain header and SHA chain, then returns a job URL.
//! `GET /v1/jobs/{session_id}` reads persisted state and exact secure-relay PTB plan.
//! `POST /v1/jobs/{session_id}/retry` reprocesses a persisted capture after restart.
//! Jobs with `ready` payloads are NOT paid until the relay confirms `ScoreAccepted`.
//! All routes except `/healthz` require bearer `PROVER_API_TOKEN` when configured.
use anyhow::Result;
use axum::{extract::{DefaultBodyLimit, Request}, http::{header, StatusCode}, middleware::{self, Next}, response::{IntoResponse, Response}, routing::get, Json, Router};
use mania_scoring_core::sha256;
use std::sync::Arc;
use crate::bridge::{self, Bridge};

const BODY_LIMIT: usize = 2 * 1024 * 1024;

fn error(code: StatusCode, text: &str) -> Response {
    (code, Json(serde_json::json!({"error":text}))).into_response()
}
pub fn router(bridge: Arc<Bridge>, token: Option<String>) -> Router {
    let expected = token.map(|t| sha256(t.as_bytes()));
    bridge::router(bridge.clone())
        .route("/v1/info", get(move || {
            let b = bridge.clone();
            async move { Json(serde_json::json!({
                "system":"gkr-sui-hardware", "srsId":mania_gkr_sui::field::hex0x(&b.srs_id),
                "srsSmax":b.srs.smax, "registryId":b.registry, "packageId":b.package,
                "capture":"bridgeos-v1-result-and-trace", "mode":3,
                "transport": if b.grpc_network.is_some() { "sui-grpc" } else { "local-json-rpc" },
                "network":b.grpc_network
            })) }
        }))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn(move |request: Request, next: Next| {
            let expected = expected;
            async move {
                if let Some(expected) = expected {
                    let valid = request.headers().get(header::AUTHORIZATION).and_then(|h| h.to_str().ok())
                        .and_then(|h| h.strip_prefix("Bearer "))
                        .is_some_and(|t| sha256(t.as_bytes()) == expected);
                    if !valid { return error(StatusCode::UNAUTHORIZED,"bearer token required"); }
                }
                next.run(request).await
            }
        }))
        .route("/healthz", get(|| async { Json(serde_json::json!({"status":"ok"})) }))
}

pub async fn serve(listener: tokio::net::TcpListener, router: Router) -> Result<()> {
    let stop = async {
        #[cfg(unix)]
        {
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! {
        result = axum::serve(listener, router) => result?,
        result = stop => result?,
    }
    Ok(())
}
