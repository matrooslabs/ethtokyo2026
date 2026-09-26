//! FPGA handoff vectors and canonical G1 ROM export. No hardware/signature emulation.
//! Default SRS is deterministic, INSECURE and for tests only.
use anyhow::{ensure, Context, Result};
use mania_gkr::field::{g1_to_words, Curve, G1Affine, Group, F, G1};
use mania_gkr::scoring::{api::device_trace_commitment, session};
use mania_gkr::zeromorph::Srs;
use mania_scoring_core::{InputEvent, SessionFooter, SessionHeader};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn hex(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
fn point(p: &G1Affine) -> Value {
    let [x, y] = g1_to_words(p);
    json!([hex(&x), hex(&y)])
}
fn event_bytes(events: &[InputEvent]) -> Vec<u8> {
    let mut b = Vec::new();
    for e in events {
        b.extend(e.sequence.to_be_bytes());
        b.extend(e.timestamp_us.to_be_bytes());
        b.extend([e.lane, e.action]);
    }
    b
}
fn header_bytes(h: &SessionHeader) -> Vec<u8> {
    let mut b = h.chain_id.to_be_bytes().to_vec();
    b.extend(h.verifier);
    b.extend(h.match_id);
    b.extend(h.session_id);
    b.extend(h.challenge);
    b.extend(h.player);
    b.extend(h.device);
    b.extend(h.chart_hash);
    b.extend(h.ruleset_id);
    b.extend(h.bitstream_hash);
    b.extend(h.input_policy_hash);
    assert_eq!(b.len(), 292);
    b
}
fn vector(srs: &Srs, name: &str, events: Vec<InputEvent>, duration: u64) -> Value {
    let h = SessionHeader {
        chain_id: 31337,
        verifier: [0x11; 20],
        match_id: [1; 32],
        session_id: [2; 32],
        challenge: [3; 32],
        player: [0x22; 20],
        device: [0x33; 20],
        chart_hash: [5; 32],
        ruleset_id: mania_scoring_core::ruleset_id(),
        bitstream_hash: [4; 32],
        input_policy_hash: session::input_policy_v2(),
    };
    let mut seed = b"OSUMANIA_TRACE_V1".to_vec();
    seed.extend(h.session_id);
    let mut root: [u8; 32] = Sha256::digest(&seed).into();
    let mut chunks = Vec::new();
    for (i, ch) in events.chunks(32).enumerate() {
        let mut pre = root.to_vec();
        pre.extend((i as u32).to_be_bytes());
        pre.extend((ch.len() as u16).to_be_bytes());
        pre.extend(event_bytes(ch));
        root = Sha256::digest(&pre).into();
        chunks.push(json!({"index":i,"count":ch.len(),"preimage":hex(&pre),"root":hex(&root)}));
    }
    assert_eq!(root, mania_scoring_core::trace_root(&h.session_id, &events));
    let mut acc = G1::identity();
    let mut prefixes = Vec::new();
    for (j, e) in events.iter().enumerate() {
        acc += srs.g1[4 * j] * F::from(e.timestamp_us);
        acc += srs.g1[4 * j + 1] * F::from(e.lane as u64);
        acc += srs.g1[4 * j + 2] * F::from(e.action as u64);
        prefixes.push(point(&acc.to_affine()));
    }
    let ce = device_trace_commitment(srs, &events);
    assert_eq!(ce, acc.to_affine()); // streamed hardware formula vs engine dense MSM
    let n = events.len() as u32;
    let hb = header_bytes(&h);
    let mut pre = b"OSUMANIA_HARDWARE_SESSION_V2".to_vec();
    pre.extend(2u16.to_be_bytes());
    pre.extend(&hb);
    pre.extend(n.to_be_bytes());
    pre.extend(duration.to_be_bytes());
    pre.extend(root);
    for w in g1_to_words(&ce) {
        pre.extend(w);
    }
    assert_eq!(pre.len(), 430);
    let digest = session::session_digest_v2(&h, n, duration, &root, &ce);
    assert_eq!(digest, <[u8; 32]>::from(Sha256::digest(&pre)));
    let mut ha = h.clone();
    ha.input_policy_hash = mania_scoring_core::input_policy_hash();
    let footer = SessionFooter {
        event_count: n,
        duration_us: duration,
        trace_root: root,
    };
    let mut pre_a = b"OSUMANIA_HARDWARE_SESSION_V1".to_vec();
    pre_a.extend(1u16.to_be_bytes());
    pre_a.extend(header_bytes(&ha));
    pre_a.extend(n.to_be_bytes());
    pre_a.extend(duration.to_be_bytes());
    pre_a.extend(root);
    assert_eq!(pre_a.len(), 366);
    let digest_a = mania_scoring_core::session_digest(&ha, &footer);
    assert_eq!(digest_a, <[u8; 32]>::from(Sha256::digest(&pre_a)));
    json!({"name":name,"scope":"encoding/commitment only; synthetic unregistered header, no chart or signature",
        "headerV2":h,"headerPackedV2":hex(&hb),"events":events,"eventBytes":hex(&event_bytes(&events)),
        "durationUs":duration,"seedPreimage":hex(&seed),"h0":hex(&Sha256::digest(&seed)),
        "chunks":chunks,"traceRoot":hex(&root),"commitmentPrefixes":prefixes,"traceCommitment":point(&ce),
        "sessionPreimageV2":hex(&pre),"sessionDigestV2":hex(&digest),
        "sessionPreimageV1":hex(&pre_a),"sessionDigestV1":hex(&digest_a)})
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |key: &str| {
        args.iter()
            .position(|x| x == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let out = PathBuf::from(arg("--out").context("--out DIRECTORY required")?);
    let supplied = arg("--srs");
    let srs = match &supplied {
        Some(p) => Srs::load(&PathBuf::from(p))?,
        None => Srs::insecure_dev(10, 20260925),
    };
    let count: usize = arg("--points")
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(260);
    ensure!(
        count >= 260 && count <= srs.g1.len(),
        "points must be in 260..=SRS length"
    );
    std::fs::create_dir_all(&out)?;
    // Canonical affine BE, not halo2curves' internal raw/Montgomery file format.
    let mut rom = Vec::with_capacity(count * 64);
    for p in &srs.g1[..count] {
        for w in g1_to_words(p) {
            rom.extend(w);
        }
    }
    let manifest = json!({"format":"G1_AFFINE_BE_XY_V1","pointCount":count,"bytesPerPoint":64,
        "curve":"BN254","firstExponent":0,"file":"srs-g1-be.bin",
        "sha256":hex(&Sha256::digest(&rom)),"srsId":hex(&srs.vk().id()),"smax":srs.smax,
        "source":if supplied.is_some(){"local SRS; provenance NOT certified by this exporter"}else{"INSECURE deterministic dev SRS; seed=20260925; NEVER deploy"}});
    std::fs::write(out.join("srs-g1-be.bin"), rom)?;
    std::fs::write(
        out.join("srs-manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    let events: Vec<InputEvent> = (0..65u32)
        .map(|j| InputEvent {
            sequence: j,
            timestamp_us: (j as u64 / 8) * 1000,
            lane: (j % 4) as u8,
            action: ((j / 4) % 2) as u8,
        })
        .collect();
    let mut cases = Vec::new();
    for n in [0, 1, 2, 31, 32, 33, 63, 64, 65] {
        cases.push(vector(
            &srs,
            &format!("boundary-{n}"),
            events[..n].to_vec(),
            1_800_000_000,
        ));
    }
    cases.push(vector(
        &srs,
        "timestamp-max",
        vec![InputEvent {
            sequence: 0,
            timestamp_us: 1_800_000_000,
            lane: 3,
            action: 0,
        }],
        1_800_000_000,
    ));
    let group = json!({"generator":"cargo run --release --locked --example fpga_vectors",
    "srsId":hex(&srs.vk().id()),"cases":cases,
    "groupArithmetic":[
        {"name":"identity-plus-generator","a":point(&G1Affine::default()),"b":point(&srs.g1[0]),"result":point(&srs.g1[0])},
        {"name":"generator-plus-negation","a":point(&srs.g1[0]),"b":point(&(-G1::from(srs.g1[0])).to_affine()),"result":point(&G1::identity().to_affine())},
        {"name":"generator-double","a":point(&srs.g1[0]),"b":point(&srs.g1[0]),"result":point(&G1::from(srs.g1[0]).double().to_affine())}
    ]});
    std::fs::write(
        out.join("device-vectors.json"),
        serde_json::to_vec_pretty(&group)?,
    )?;
    println!(
        "exported {} vectors and {} canonical G1 points to {}",
        10,
        count,
        out.display()
    );
    Ok(())
}
