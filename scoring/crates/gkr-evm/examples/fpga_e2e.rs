//! Software FPGA boundary simulator and strict mode-B prover adapter.
//! Virtual-time edges, real SHA/KZG/proofs; no claim of physical input attestation.
use anyhow::{bail, ensure, Context, Result};
use mania_gkr::field::{
    g1_from_words, g1_to_words, g2_to_words, words_to_hex, Curve, Group, F, G1,
};
use mania_gkr::scoring::{api, encode, prover, session, witness, Mode};
use mania_gkr::{
    testutil,
    zeromorph::{self, Srs},
};
use mania_scoring_core::{
    chart_hash, ruleset_id, trace_root, InputEvent, PlayInput, SessionFooter, SessionHeader,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

fn hex0(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
fn write(p: impl AsRef<Path>, v: &Value) -> Result<()> {
    std::fs::write(p, serde_json::to_vec_pretty(v)?)?;
    Ok(())
}
fn read(p: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(p)?)?)
}
fn bytes<const N: usize>(v: &Value) -> Result<[u8; N]> {
    hex::decode(
        v.as_str()
            .context("expected hex string")?
            .trim_start_matches("0x"),
    )?
    .try_into()
    .map_err(|_| anyhow::anyhow!("wrong byte length"))
}

fn prepare(srs: &Srs, out: &Path, counts: &str) -> Result<()> {
    let vk = srs.vk();
    write(
        out.join("vk.json"),
        &json!({"smax":srs.smax,"srsId":hex0(&vk.id()),
        "g2One":words_to_hex(&g2_to_words(&vk.g2_one)),"g2Tau":words_to_hex(&g2_to_words(&vk.g2_tau)),
        "g2Shift":vk.g2_shift.iter().map(|p|words_to_hex(&g2_to_words(p))).collect::<Vec<_>>() }),
    )?;
    for count in counts.split(',') {
        let n: usize = count.parse()?;
        ensure!((1..=10_000).contains(&n), "invalid note count");
        let input = testutil::benchmark_input(n, false);
        let t = Instant::now();
        let reg = session::register_chart(srs, &input.chart)?;
        let elapsed = ms(t);
        session::verify_chart_registration(&vk, &input.chart, &reg.record.commitment, &reg.proof)?;
        let dir = out.join(count);
        std::fs::create_dir_all(&dir)?;
        write(dir.join("template.json"), &serde_json::to_value(&input)?)?;
        write(
            dir.join("chart.json"),
            &json!({"notes":n,"events":input.events.len(),
            "chartHash":hex0(&reg.chart_hash),"bytes":hex0(&session::chart_bytes(&input.chart)),
            "commitment":words_to_hex(&g1_to_words(&reg.record.commitment)),
            "proof":words_to_hex(&zeromorph::proof_words(&reg.proof)),"registrationProveMs":elapsed,
            "components":reg.record.components,"maxEnd":reg.record.max_end,"bits":reg.record.bits}),
        )?;
    }
    Ok(())
}

fn capture(
    srs: &Srs,
    input_path: &Path,
    header_path: &Path,
    out: &Path,
    load_ms: f64,
) -> Result<()> {
    let template: PlayInput = serde_json::from_slice(&std::fs::read(input_path)?)?;
    let header: SessionHeader = serde_json::from_slice(&std::fs::read(header_path)?)?;
    ensure!(
        header.input_policy_hash == session::input_policy_v2(),
        "not a mode B header"
    );
    ensure!(
        header.chart_hash == chart_hash(&template.chart) && header.ruleset_id == ruleset_id(),
        "chart/rules mismatch"
    );
    // A virtual local clock supplies edge timestamps. This loop has no wall-clock sleep.
    // Only one accepted event object fans out into the journal, SHA and KZG paths.
    let start = Instant::now();
    let mut seed = b"OSUMANIA_TRACE_V1".to_vec();
    seed.extend(header.session_id);
    let mut root: [u8; 32] = Sha256::digest(seed).into();
    let mut chunk = Vec::with_capacity(448);
    let mut chunk_count = 0u16;
    let mut chunk_index = 0u32;
    let mut held = [false; 4];
    let mut events = Vec::with_capacity(template.events.len());
    let mut ce = G1::identity();
    let mut kzg_ms = 0.0;
    let mut sha_ms = 0.0;
    let duration = template.footer.duration_us;
    let flush = |root: &mut [u8; 32], chunk: &mut Vec<u8>, count: u16, index: u32| {
        let mut h = Sha256::new();
        h.update(*root);
        h.update(index.to_be_bytes());
        h.update(count.to_be_bytes());
        h.update(&*chunk);
        *root = h.finalize().into();
        chunk.clear();
    };
    for edge in &template.events {
        let j = events.len();
        ensure!(
            j < 50_000 && edge.lane < 4 && edge.action <= 1,
            "invalid edge"
        );
        ensure!(edge.timestamp_us <= duration, "edge after STOP");
        if let Some(prev) = events.last() {
            let prev: &InputEvent = prev;
            ensure!(prev.timestamp_us <= edge.timestamp_us, "clock decreased");
        }
        let lane = edge.lane as usize;
        ensure!(held[lane] == (edge.action == 1), "invalid held transition");
        held[lane] = edge.action == 0;
        let e = InputEvent {
            sequence: j as u32,
            timestamp_us: edge.timestamp_us,
            lane: edge.lane,
            action: edge.action,
        };
        ensure!(4 * j + 2 < srs.g1.len(), "SRS too short for device");
        let t = Instant::now();
        ce += srs.g1[4 * j] * F::from(e.timestamp_us);
        ce += srs.g1[4 * j + 1] * F::from(e.lane as u64);
        ce += srs.g1[4 * j + 2] * F::from(e.action as u64);
        kzg_ms += ms(t);
        let t = Instant::now();
        chunk.extend(e.sequence.to_be_bytes());
        chunk.extend(e.timestamp_us.to_be_bytes());
        chunk.extend([e.lane, e.action]);
        chunk_count += 1;
        if chunk_count == 32 {
            flush(&mut root, &mut chunk, chunk_count, chunk_index);
            chunk_count = 0;
            chunk_index += 1;
        }
        sha_ms += ms(t);
        events.push(e);
    }
    if chunk_count > 0 {
        let t = Instant::now();
        flush(&mut root, &mut chunk, chunk_count, chunk_index);
        sha_ms += ms(t);
        chunk_index += 1;
    }
    let t = Instant::now();
    let ce = ce.to_affine();
    let normalize_ms = ms(t);
    let footer = SessionFooter {
        event_count: events.len() as u32,
        duration_us: duration,
        trace_root: root,
    };
    let t = Instant::now();
    let digest = session::session_digest_v2(&header, footer.event_count, duration, &root, &ce);
    let digest_ms = ms(t);
    let capture_ms = ms(start);
    let input = PlayInput {
        header,
        footer,
        chart: template.chart,
        events,
    };
    // Independent batch reference catches streaming index/fanout errors.
    let t = Instant::now();
    ensure!(
        root == trace_root(&input.header.session_id, &input.events),
        "stream SHA mismatch"
    );
    ensure!(
        ce == api::device_trace_commitment(srs, &input.events),
        "stream KZG mismatch"
    );
    let expected = witness::reference(&input.chart, &input.events, duration)?;
    let crosscheck_ms = ms(t);
    write(out.join("play.json"), &serde_json::to_value(&input)?)?;
    write(
        out.join("device-result.json"),
        &json!({"kind":"SOFTWARE_FPGA_SIMULATION_VIRTUAL_TIME",
        "header":input.header,"n":input.events.len(),"duration":duration,"root":hex0(&root),
        "traceCommitment":words_to_hex(&g1_to_words(&ce)),"sessionDigest":hex0(&digest),
        "srsId":hex0(&srs.vk().id()),"chunks":chunk_index,"expectedScore":expected.score,
        "expectedJudgements":expected.judgements,"timings":{"srsLoadMs":load_ms,
        "captureComputeMs":capture_ms,"streamKzgMs":kzg_ms,"chunkShaMs":sha_ms,
        "normalizeMs":normalize_ms,"digestMs":digest_ms,"crosscheckMs":crosscheck_ms},
        "virtualPlaySeconds":duration as f64 / 1e6}),
    )?;
    Ok(())
}

fn prove(srs: &Srs, out: &Path, load_ms: f64) -> Result<()> {
    let input: PlayInput = serde_json::from_slice(&std::fs::read(out.join("play.json"))?)?;
    let seal = read(&out.join("device-result.json"))?;
    let expected_header: SessionHeader = serde_json::from_value(seal["header"].clone())?;
    ensure!(
        serde_json::to_value(&input.header)? == serde_json::to_value(expected_header)?,
        "header changed after seal"
    );
    ensure!(
        input.header.chart_hash == chart_hash(&input.chart)
            && input.header.ruleset_id == ruleset_id(),
        "chart/rules mismatch"
    );
    ensure!(
        input.header.input_policy_hash == session::input_policy_v2(),
        "wrong policy"
    );
    ensure!(
        seal["n"].as_u64() == Some(input.events.len() as u64)
            && input.footer.event_count as usize == input.events.len(),
        "event count mismatch"
    );
    ensure!(
        seal["duration"].as_u64() == Some(input.footer.duration_us),
        "duration mismatch"
    );
    let root = bytes::<32>(&seal["root"])?;
    ensure!(
        root == input.footer.trace_root
            && root == trace_root(&input.header.session_id, &input.events),
        "root mismatch"
    );
    ensure!(
        bytes::<32>(&seal["srsId"])? == srs.vk().id(),
        "SRS mismatch"
    );
    let ce = g1_from_words(&[
        bytes::<32>(&seal["traceCommitment"][0])?,
        bytes::<32>(&seal["traceCommitment"][1])?,
    ])
    .context("bad G1")?;
    let preflight = Instant::now();
    ensure!(
        ce == api::device_trace_commitment(srs, &input.events),
        "device commitment mismatch"
    );
    ensure!(
        bytes::<32>(&seal["sessionDigest"])?
            == session::session_digest_v2(
                &input.header,
                input.footer.event_count,
                input.footer.duration_us,
                &root,
                &ce
            ),
        "digest mismatch"
    );
    let preflight_ms = ms(preflight);
    let t = Instant::now();
    let reg = session::register_chart(srs, &input.chart)?;
    let chart_ms = ms(t);
    let t = Instant::now();
    let w = witness::build_from_input(&input)?;
    let witness_ms = ms(t);
    ensure!(
        prover::shape_of(&w).opening_vars() <= srs.smax,
        "instance exceeds SRS"
    );
    // Preserve the original mode-B header and device commitment. Do not rebind/reseal.
    let statement = api::statement(
        &input,
        &reg.record,
        Mode::Committed,
        srs.vk().id(),
        Some(ce),
    );
    let (proof, mut timing) = prover::prove(&w, &statement, srs, &input.events)?;
    timing.witness_ms = witness_ms;
    timing.total_ms += witness_ms;
    let t = Instant::now();
    let result = api::verify(&srs.vk(), &statement, &proof, None)?;
    let verify_ms = ms(t);
    ensure!(
        seal["expectedScore"].as_u64() == Some(result.score),
        "reference score mismatch"
    );
    let words = encode::proof_words(&proof);
    write(
        out.join("proof.json"),
        &json!({"mode":2,"sessionDigest":hex0(&statement.session_digest),
        "n":statement.n,"duration":statement.duration,"root":hex0(&root),
        "traceCommitment":words_to_hex(&g1_to_words(&ce)),"chartCommitment":words_to_hex(&g1_to_words(&reg.record.commitment)),
        "laneBits":proof.lane_bits,"counts":proof.counts,"proof":words_to_hex(&words),
        "proofWords":words.len(),"proofBytes":32*words.len(),"result":result,
        "timings":timing,"srsLoadMs":load_ms,"adapterPreflightMs":preflight_ms,
        "chartRegistrationRecomputeMs":chart_ms,"nativeVerifyMs":verify_ms}),
    )?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |key: &str| -> Result<String> {
        args.iter()
            .position(|x| x == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .with_context(|| format!("missing {key}"))
    };
    let out = PathBuf::from(arg("--out")?);
    std::fs::create_dir_all(&out)?;
    let t = Instant::now();
    let srs = Srs::load(Path::new(&arg("--srs")?))?;
    let load_ms = ms(t);
    match args.get(1).map(String::as_str) {
        Some("prepare") => prepare(&srs, &out, &arg("--cases")?),
        Some("capture") => capture(
            &srs,
            Path::new(&arg("--input")?),
            Path::new(&arg("--header")?),
            &out,
            load_ms,
        ),
        Some("prove") => prove(&srs, &out, load_ms),
        _ => bail!("expected prepare|capture|prove --srs FILE --out DIR"),
    }
}
