use super::*;
use mania_gkr_sui::sui::{device_address, device_pubkey, events_bytes, sign_digest};
use k256::ecdsa::SigningKey;

fn sealed_capture(srs: &Srs) -> (SessionHeader, Capture, String) {
    let mut input: PlayInput = serde_json::from_str(include_str!("../../../fixtures/demo.json")).unwrap();
    let key = SigningKey::from_bytes(&[0x42u8; 32].into()).unwrap();
    input.header.device = device_address(&key);
    input.header.input_policy_hash = sha256(INPUT_POLICY_V2);
    let pubkey = hex0x(&device_pubkey(&key));
    let mut result = Vec::from(header_bytes(&input.header));
    result.extend_from_slice(&input.footer.event_count.to_be_bytes());
    result.extend_from_slice(&input.footer.duration_us.to_be_bytes());
    result.extend_from_slice(&input.footer.trace_root);
    result.extend_from_slice(&g1_to_bytes(&api::device_trace_commitment(srs, &input.events)));
    let mut preimage = Vec::from(SESSION_DOMAIN_V2);
    preimage.extend_from_slice(&2u16.to_be_bytes());
    preimage.extend_from_slice(&result);
    result.extend_from_slice(&sign_digest(&key, &sha256(&preimage)));
    let capture = Capture {
        session_id: hex0x(&input.header.session_id),
        result_hex: hex0x(&result),
        trace_hex: hex0x(&events_bytes(&input.events)),
        chart: input.chart.clone(),
    };
    (input.header, capture, pubkey)
}

#[test]
fn preserves_device_signed_digest_and_rejects_altered_trace_and_signature() {
    let srs = Srs::insecure_dev(16, 1);
    let (header, capture, key) = sealed_capture(&srs);
    let (play, digest, _, _) = parse_capture(header.clone(), &capture, &key, &srs).unwrap();
    assert_ne!(digest, mania_scoring_core::session_digest(&header, &play.footer));
    let original_result = capture.result_hex.clone();
    let mut modified = capture;
    let mut bytes = parse_hex(&modified.trace_hex, play.events.len() * 14).unwrap();
    bytes[5] ^= 1;
    modified.trace_hex = hex0x(&bytes);
    assert!(parse_capture(header.clone(), &modified, &key, &srs).unwrap_err().to_string().contains("trace root"));
    modified.trace_hex = hex0x(&events_bytes(&play.events));
    let mut result = parse_hex(&modified.result_hex, RESULT_SIZE).unwrap();
    result[340] ^= 1;
    modified.result_hex = hex0x(&result);
    assert!(parse_capture(header.clone(), &modified, &key, &srs).is_err());
    result = parse_hex(&original_result, RESULT_SIZE).unwrap();
    let mut different = play.events.clone();
    different[0].timestamp_us += 1;
    result[336..384].copy_from_slice(&g1_to_bytes(&api::device_trace_commitment(&srs, &different)));
    modified.result_hex = hex0x(&result);
    assert!(parse_capture(header.clone(), &modified, &key, &srs).unwrap_err().to_string().contains("commitment"));
    result = parse_hex(&original_result, RESULT_SIZE).unwrap();
    result[389] ^= 1;
    modified.result_hex = hex0x(&result);
    assert!(parse_capture(header.clone(), &modified, &key, &srs).is_err());
    result[292..296].copy_from_slice(&70_001u32.to_be_bytes());
    modified.result_hex = hex0x(&result);
    assert!(parse_capture(header, &modified, &key, &srs).unwrap_err().to_string().contains("capacity"));
}

#[tokio::test]
async fn registered_session_produces_verified_hardware_relay_plan() {
    use axum::{routing::post, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let srs = Srs::insecure_dev(16, 1);
    let (mut h, mut capture, pubkey) = sealed_capture(&srs);
    let registry = [0x31; 32];
    h.verifier.copy_from_slice(&keccak(&[&registry])[12..]);
    let mut raw = parse_hex(&capture.result_hex, RESULT_SIZE).unwrap();
    raw[..HEADER_SIZE].copy_from_slice(&header_bytes(&h));
    let mut preimage = Vec::from(SESSION_DOMAIN_V2);
    preimage.extend_from_slice(&2u16.to_be_bytes());
    preimage.extend_from_slice(&raw[..384]);
    let key = SigningKey::from_bytes(&[0x42u8; 32].into()).unwrap();
    raw[384..].copy_from_slice(&sign_digest(&key, &sha256(&preimage)));
    capture.result_hex = hex0x(&raw);
    let reg = register_chart(&srs, &capture.chart).unwrap();
    let srs_id = srs.vk().id();
    let device = h.device;
    let chart = reg.record;
    let registry_hex = hex0x(&registry);
    let sid = capture.session_id.clone();
    let session_header = serde_json::to_value(&h).unwrap();
    let rpc = Router::new().route("/", post(move |Json(call): Json<Value>| {
        let h = session_header.clone();
        let sid = sid.clone();
        let registry_hex = registry_hex.clone();
        let pubkey = pubkey.clone();
        async move {
            let body = match call["method"].as_str().unwrap() {
                "sui_getObject" if call["params"][0] == sid => json!({
                    "data":{"content":{"dataType":"moveObject","type":format!("{}::registry::Session",hex0x(&[0x22;32])),"fields":{
                        "registry":registry_hex,"consumed":false,"mode":"2","expires_at_ms":"4102444800000",
                        "header":{"fields":h}
                    }}}
                }),
                "sui_getObject" => json!({"data":{"content":{"dataType":"moveObject","type":format!("{}::registry::Registry",hex0x(&[0x22;32])),"fields":{
                    "chain_id":h["chain_id"],"verifier_tag":h["verifier"],
                    "vk":{"fields":{"id":srs_id,"smax":"16"}},
                    "devices":{"fields":{"id":{"id":"0x33"}}},
                    "charts":{"fields":{"id":{"id":"0x44"}}}
                }}}}),
                "suix_getDynamicFieldObject" if call["params"][0] == "0x33" => json!({
                    "data":{"content":{"fields":{"value":{"fields":{
                        "active":true,"bitstream_hash":h["bitstream_hash"],"pubkey":pubkey
                    }}}}}
                }),
                "suix_getDynamicFieldObject" => json!({"data":{"content":{"fields":{"value":{"fields":{
                    "commitment":g1_to_bytes(&chart.commitment).to_vec(),"m":chart.m.to_string(),
                    "bits":chart.bits.to_string(),"components":chart.components.to_string(),
                    "max_end":chart.max_end.to_string()
                }}}}}}),
                other => panic!("unexpected RPC method: {other}"),
            };
            Json(json!({"jsonrpc":"2.0","id":1,"result":body}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, rpc).await.unwrap(); });
    let dir = std::env::temp_dir().join(format!("versu-bridge-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let bridge = Arc::new(Bridge::new(srs, rpc_url, hex0x(&registry), hex0x(&[0x22; 32]), dir.clone()).unwrap());
    let mut info = [0u8; INFO_SIZE];
    info[..2].copy_from_slice(&1u16.to_be_bytes());
    info[2..4].copy_from_slice(&64u16.to_be_bytes());
    info[8..28].copy_from_slice(&device);
    info[28..60].copy_from_slice(&h.bitstream_hash);
    info[60..92].copy_from_slice(&h.input_policy_hash);
    info[92..124].copy_from_slice(&bridge.bank_hash);
    info[124..128].copy_from_slice(&bridge.bank_events.to_be_bytes());
    let app = super::super::http::router(bridge.clone(), None);
    let start_body = json!({"sessionId":capture.session_id,"infoHex":hex0x(&info),"statusHex":hex0x(&[0;16])});
    let req = axum::http::Request::builder().method("POST").uri("/v1/sessions/start")
        .header("content-type","application/json").body(axum::body::Body::from(start_body.to_string())).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let start: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(start["headerHex"], hex0x(&header_bytes(&h)));
    let mut recording_status = [0u8; 16];
    recording_status[0] = 2;
    let not_ready = json!({"sessionId":capture.session_id,"infoHex":hex0x(&info),"statusHex":hex0x(&recording_status)});
    let req = axum::http::Request::builder().method("POST").uri("/v1/sessions/start")
        .header("content-type","application/json").body(axum::body::Body::from(not_ready.to_string())).unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let rejected: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(rejected["error"].as_str().unwrap().contains("not idle"));
    let expected_digest = sha256(&preimage);
    let submit_req = axum::http::Request::builder().method("POST").uri("/v1/sessions/submit")
        .header("content-type","application/json")
        .body(axum::body::Body::from(serde_json::to_string(&capture).unwrap())).unwrap();
    let submitted = app.clone().oneshot(submit_req).await.unwrap();
    assert_eq!(submitted.status(), StatusCode::ACCEPTED);
    let payload = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let req = axum::http::Request::builder().uri(format!("/v1/jobs/{}", capture.session_id))
                .body(axum::body::Body::empty()).unwrap();
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let job: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
            match job["state"].as_str().unwrap() {
                "ready" => break job["payload"].clone(),
                "proving" => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
                state => panic!("unexpected proof state {state}: {job}"),
            }
        }
    }).await.unwrap();
    assert_eq!(payload["sessionDigest"], hex0x(&expected_digest));
    assert_eq!(payload["mode"], "committed");
    assert_eq!(payload["n"], u32::from_be_bytes(raw[292..296].try_into().unwrap()).to_string());
    assert_eq!(payload["traceCommitment"], hex0x(&raw[336..384]));
    assert_eq!(payload["signature"], hex0x(&raw[384..]));
    assert!(payload.get("traceBatches").is_none());
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while bridge.busy.available_permits() == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let mut persisted = bridge.load(&capture.session_id).unwrap();
    assert_eq!(persisted.state, "ready");
    persisted.state = "proving".into(); // Simulate process termination before the job completed.
    persisted.payload = None;
    bridge.save(&persisted).unwrap();
    let uri = format!("/v1/jobs/{}", capture.session_id);
    let interrupted = app.clone().oneshot(axum::http::Request::builder().uri(&uri)
        .body(axum::body::Body::empty()).unwrap()).await.unwrap();
    let interrupted: Value = serde_json::from_slice(&interrupted.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(interrupted["state"], "interrupted");
    let retried = app.clone().oneshot(axum::http::Request::builder().method("POST")
        .uri(format!("{uri}/retry")).body(axum::body::Body::empty()).unwrap()).await.unwrap();
    assert_eq!(retried.status(), StatusCode::ACCEPTED);
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let state = bridge.load(&capture.session_id).unwrap();
            if state.state == "ready" {
                assert_eq!(state.payload.unwrap()["sessionDigest"], hex0x(&expected_digest));
                break;
            }
            assert_eq!(state.state, "proving", "{}", state.error.unwrap_or_default());
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while bridge.busy.available_permits() == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    server.abort();
    fs::remove_dir_all(dir).unwrap();
}
