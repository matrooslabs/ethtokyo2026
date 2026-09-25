//! Foundry fixtures (`export-forge`) and the FFI prover (`prove-session`).
use crate::field::{fe_to_be, g1_to_words, g2_to_words, words_to_hex, Word, F};
use crate::scoring::api;
use crate::scoring::encode::{proof_words, shape_for};
use crate::scoring::layout::claim_columns;
use crate::scoring::session::{chart_bytes, register_chart};
use crate::scoring::{ChartRecord, Mode, ScoreProof};
use crate::testutil::{benchmark_input, random_input};
use crate::zeromorph::{self, Srs};
use anyhow::{bail, ensure, Context, Result};
use mania_scoring_core::{evaluate, PlayInput, SessionHeader};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub fn events_bytes(input: &PlayInput) -> Vec<u8> {
    let mut out = Vec::with_capacity(14 * input.events.len());
    for e in &input.events {
        out.extend(e.sequence.to_be_bytes());
        out.extend(e.timestamp_us.to_be_bytes());
        out.push(e.lane);
        out.push(e.action);
    }
    out
}

/// Word offsets of each proof section (for tamper tests).
fn sections(p: &ScoreProof, chart_bits: u64, n: u64) -> Value {
    let shape = shape_for(&p.lane_bits, chart_bits, n);
    let (_, g) = shape.leaf_layout();
    let gkr_words = 4 + (1..g).map(|k| 3 * k + 4).sum::<usize>();
    let row = 2 + gkr_words;
    let claims = row + 4 * shape.r_max();
    let red = claims + claim_columns().len();
    let finals = red + 2 * shape.opening_vars();
    let zm = finals + 2 + p.trace_eval.is_some() as usize;
    json!({ "gkr": 2, "row": row, "claims": claims, "red": red, "finals": finals, "zm": zm })
}

fn chart_json(srs: &Srs, input: &PlayInput) -> Result<(Value, ChartRecord)> {
    let reg = register_chart(srs, &input.chart)?;
    let v = json!({
        "bytes": hex0x(&chart_bytes(&input.chart)),
        "commitment": words_to_hex(&g1_to_words(&reg.record.commitment)),
        "proof": words_to_hex(&zeromorph::proof_words(&reg.proof)),
        "chartHash": hex0x(&reg.chart_hash),
        "m": reg.record.m, "bits": reg.record.bits, "components": reg.record.components, "maxEnd": reg.record.max_end,
    });
    Ok((v, reg.record))
}

fn case_json(srs: &Srs, name: &str, input: &PlayInput, mode: Mode) -> Result<Value> {
    let (chart, record) = chart_json(srs, input)?;
    let proved = api::prove(srs, input, &record, mode)?;
    let st = &proved.statement;
    let words = proof_words(&proved.proof);
    let reference = evaluate(input).map_err(anyhow::Error::msg)?;
    let tc = st
        .trace_commitment
        .map(|c| g1_to_words(&c))
        .unwrap_or([[0u8; 32]; 2]);
    Ok(json!({
        "name": name,
        "mode": mode as u8,
        "sessionDigest": hex0x(&st.session_digest),
        "n": st.n, "duration": st.duration,
        "traceCommitment": words_to_hex(&tc),
        "laneBits": proved.proof.lane_bits, "counts": proved.proof.counts,
        "events": hex0x(&events_bytes(input)),
        "proof": words_to_hex(&words),
        "sections": sections(&proved.proof, st.chart.bits, st.n),
        "judgements": reference.judgements, "score": reference.score,
        "proveMs": proved.timings.total_ms,
        "chart": chart,
    }))
}

pub fn export(args: &[String]) -> Result<()> {
    let srs = Srs::load(Path::new(&arg(args, "--srs").context("missing --srs")?))?;
    let out = PathBuf::from(arg(args, "--out").context("missing --out")?);
    std::fs::create_dir_all(&out)?;
    let vk = srs.vk();
    let shift: Vec<String> = vk
        .g2_shift
        .iter()
        .flat_map(|p| words_to_hex(&g2_to_words(p)))
        .collect();
    let vk_json = json!({
        "smax": vk.smax,
        "g2One": words_to_hex(&g2_to_words(&vk.g2_one)),
        "g2Tau": words_to_hex(&g2_to_words(&vk.g2_tau)),
        "g2Shift": shift,
        "g1One": words_to_hex(&g1_to_words(&vk.g1_one)),
        "srsId": hex0x(&vk.id()),
    });
    std::fs::write(out.join("vk.json"), serde_json::to_string_pretty(&vk_json)?)?;
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sp1-scoring/fixtures");
    let load = |f: &str| -> Result<PlayInput> {
        Ok(serde_json::from_slice(&std::fs::read(fixtures.join(f))?)?)
    };
    let mut cases: Vec<(String, PlayInput)> = vec![
        ("demo".into(), load("demo.json")?),
        ("perfect".into(), load("perfect.json")?),
    ];
    let mut seed = 0u64;
    while cases.len() < 5 {
        let input = random_input(seed);
        if evaluate(&input).is_ok() && input.events.len() > 10 {
            cases.push((format!("random{seed}"), input));
        }
        seed += 1;
    }
    let sizes: Vec<usize> = arg(args, "--bench")
        .map(|s| s.split(',').map(|x| x.parse().unwrap()).collect())
        .unwrap_or(vec![500, 3000]);
    for count in sizes {
        let input = benchmark_input(count, false);
        std::fs::write(
            out.join(format!("play-bench{count}.json")),
            serde_json::to_string(&input)?,
        )?;
        cases.push((format!("bench{count}"), input));
    }
    let mut index = Vec::new();
    for (name, input) in &cases {
        for mode in [Mode::Calldata, Mode::Committed] {
            let tag = format!("{name}-{}", if mode == Mode::Calldata { "a" } else { "b" });
            let v = case_json(&srs, &tag, input, mode)?;
            std::fs::write(
                out.join(format!("case-{tag}.json")),
                serde_json::to_string(&v)?,
            )?;
            eprintln!(
                "exported {tag}: {} proof words",
                v["proof"].as_array().unwrap().len()
            );
            index.push(tag);
        }
    }
    std::fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&json!({ "cases": index }))?,
    )?;
    Ok(())
}

fn parse_header(hex_str: &str) -> Result<SessionHeader> {
    let bytes = hex::decode(hex_str.trim_start_matches("0x"))?;
    ensure!(
        bytes.len() == 11 * 32,
        "header must be abi.encode(Header): 11 words"
    );
    let w = |i: usize| -> [u8; 32] { bytes[32 * i..32 * i + 32].try_into().unwrap() };
    let addr = |i: usize| -> [u8; 20] { bytes[32 * i + 12..32 * i + 32].try_into().unwrap() };
    let chain = u64::from_be_bytes(bytes[24..32].try_into().unwrap());
    Ok(SessionHeader {
        chain_id: chain,
        verifier: addr(1),
        match_id: w(2),
        session_id: w(3),
        challenge: w(4),
        player: addr(5),
        device: addr(6),
        chart_hash: w(7),
        ruleset_id: w(8),
        bitstream_hash: w(9),
        input_policy_hash: w(10),
    })
}

/// `prove-session --srs FILE --input PLAY.json --mode a|b --header 0x<abi.encode(Header)>`
/// Prints 0x-hex of abi.encode(uint256[]) =
/// [laneBits×4, counts×5, tcX, tcY, sessionDigest, n, duration, traceRoot, proof words…].
pub fn prove_session(args: &[String]) -> Result<()> {
    let srs = Srs::load(Path::new(&arg(args, "--srs").context("missing --srs")?))?;
    let mut input: PlayInput = serde_json::from_slice(&std::fs::read(
        arg(args, "--input").context("missing --input")?,
    )?)?;
    let mode = match arg(args, "--mode").as_deref() {
        Some("a") => Mode::Calldata,
        Some("b") => Mode::Committed,
        _ => bail!("--mode a|b"),
    };
    let header = parse_header(&arg(args, "--header").context("missing --header")?)?;
    // Rebind the recorded play to the contract-issued session (a real device would sign this).
    input.header = header.clone();
    input.footer.trace_root = mania_scoring_core::trace_root(&header.session_id, &input.events);
    let reg = register_chart(&srs, &input.chart)?;
    // For mode B the contract header already carries the V2 input policy; api::prove sets the same value.
    let proved = api::prove(&srs, &input, &reg.record, mode)?;
    let st = &proved.statement;
    let mut words: Vec<Word> = Vec::new();
    words.extend(
        proved
            .proof
            .lane_bits
            .iter()
            .map(|&b| fe_to_be(&F::from(b))),
    );
    words.extend(proved.proof.counts.iter().map(|&c| fe_to_be(&F::from(c))));
    words.extend(
        st.trace_commitment
            .map(|c| g1_to_words(&c))
            .unwrap_or([[0u8; 32]; 2]),
    );
    words.push(st.session_digest);
    words.push(fe_to_be(&F::from(st.n)));
    words.push(fe_to_be(&F::from(st.duration)));
    words.push(input.footer.trace_root);
    words.extend(proof_words(&proved.proof));
    let mut enc = Vec::with_capacity(64 + 32 * words.len());
    enc.extend(fe_to_be(&F::from(32u64)));
    enc.extend(fe_to_be(&F::from(words.len() as u64)));
    for w in &words {
        enc.extend(w);
    }
    println!("{}", hex0x(&enc));
    Ok(())
}
