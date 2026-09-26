//! CLI: dev SRS generation, proving/verifying fixtures, benchmarks, Solidity fixture export.
use anyhow::{bail, Context, Result};
use mania_gkr::field::{g1_to_words, words_to_hex};
use mania_gkr::scoring::api;
use mania_gkr::scoring::encode;
use mania_gkr::scoring::prover::shape_of;
use mania_gkr::scoring::session::register_chart;
use mania_gkr::scoring::Mode;
use mania_gkr::testutil::benchmark_input;
use mania_gkr::zeromorph::Srs;
use mania_scoring_core::PlayInput;
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn need(args: &[String], name: &str) -> Result<String> {
    arg(args, name).with_context(|| format!("missing {name}"))
}

fn load_srs(args: &[String]) -> Result<(Srs, f64)> {
    let t = Instant::now();
    let srs = Srs::load(&PathBuf::from(need(args, "--srs")?))?;
    Ok((srs, t.elapsed().as_secs_f64() * 1e3))
}

fn parse_mode(s: &str) -> Result<Mode> {
    Ok(match s {
        "a" | "A" | "calldata" => Mode::Calldata,
        "b" | "B" | "committed" => Mode::Committed,
        _ => bail!("mode must be a|b"),
    })
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn bench(args: &[String]) -> Result<()> {
    let (srs, srs_ms) = load_srs(args)?;
    let reps: usize = arg(args, "--reps")
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(3);
    let cases = arg(args, "--cases").unwrap_or_else(|| "500,1500,3000,3000ln".into());
    let vk = srs.vk();
    let mut rows = Vec::new();
    for case in cases.split(',') {
        let ln = case.ends_with("ln");
        let count: usize = case.trim_end_matches("ln").parse()?;
        let input = benchmark_input(count, ln);
        let t = Instant::now();
        let reg = register_chart(&srs, &input.chart)?;
        let register_ms = t.elapsed().as_secs_f64() * 1e3;
        for mode in [Mode::Calldata, Mode::Committed] {
            let mut totals = Vec::new();
            let mut last = None;
            for _ in 0..reps {
                let p = api::prove(&srs, &input, &reg.record, mode)?;
                totals.push(p.timings.total_ms);
                last = Some(p);
            }
            let p = last.unwrap();
            let events = (mode == Mode::Calldata).then_some(&input.events[..]);
            let mut vt = Vec::new();
            for _ in 0..reps {
                let t = Instant::now();
                api::verify(&vk, &p.statement, &p.proof, events)?;
                vt.push(t.elapsed().as_secs_f64() * 1e3);
            }
            let res = api::verify(&vk, &p.statement, &p.proof, events)?;
            let dev_ms = if mode == Mode::Committed {
                let t = Instant::now();
                api::device_trace_commitment(&srs, &input.events);
                Some(t.elapsed().as_secs_f64() * 1e3)
            } else {
                None
            };
            let shape = shape_of(&p.witness);
            let (_, g) = shape.leaf_layout();
            let words = encode::proof_words(&p.proof).len();
            let row = json!({
                "case": case, "mode": format!("{mode:?}"), "notes": count, "events": input.events.len(),
                "score": res.score, "tableBits": shape.bits, "leafVars": g, "openingVars": shape.opening_vars(),
                "proveMsMedian": median(totals.clone()), "proveMsAll": totals, "lastTimings": p.timings,
                "verifyNativeMsMedian": median(vt), "proofWords": words, "proofBytes": words * 32,
                "deviceCommitMs": dev_ms, "chartRegistrationProveMs": register_ms,
            });
            println!("{}", serde_json::to_string(&row)?);
            rows.push(row);
        }
    }
    let summary = json!({ "srsLoadMs": srs_ms, "srsSmax": srs.smax, "threads": rayon::current_num_threads(), "rows": rows });
    if let Some(out) = arg(args, "--out") {
        std::fs::write(&out, serde_json::to_string_pretty(&summary)?)?;
    }
    Ok(())
}

fn prove_cmd(args: &[String]) -> Result<()> {
    let (srs, srs_ms) = load_srs(args)?;
    let input: PlayInput = serde_json::from_slice(&std::fs::read(need(args, "--input")?)?)?;
    let mode = parse_mode(&arg(args, "--mode").unwrap_or_else(|| "a".into()))?;
    let reg = register_chart(&srs, &input.chart)?;
    let p = api::prove(&srs, &input, &reg.record, mode)?;
    let events = (mode == Mode::Calldata).then_some(&input.events[..]);
    let res = api::verify(&srs.vk(), &p.statement, &p.proof, events)?;
    let words = encode::proof_words(&p.proof);
    let out = json!({
        "mode": format!("{mode:?}"), "result": res, "timings": p.timings, "srsLoadMs": srs_ms,
        "laneBits": p.proof.lane_bits, "counts": p.proof.counts, "proof": words_to_hex(&words),
        "chartCommitment": words_to_hex(&g1_to_words(&reg.record.commitment)),
        "traceCommitment": p.statement.trace_commitment.map(|c| words_to_hex(&g1_to_words(&c))),
        "sessionDigest": format!("0x{}", hex::encode(p.statement.session_digest)),
    });
    let text = serde_json::to_string_pretty(&out)?;
    match arg(args, "--out") {
        Some(path) => std::fs::write(path, text)?,
        None => println!("{text}"),
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("srs") => {
            let smax: usize = need(&args, "--smax")?.parse()?;
            let seed: u64 = arg(&args, "--seed").map(|s| s.parse()).transpose()?.unwrap_or(1);
            let t = Instant::now();
            let (srs, kind) = match arg(&args, "--ptau") {
                Some(p) => (Srs::from_ptau(&PathBuf::from(p), smax)?, "ceremony SRS from .ptau (validated)"),
                None => (Srs::insecure_dev(smax, seed), "INSECURE dev SRS (known tau)"),
            };
            srs.save(&PathBuf::from(need(&args, "--out")?))?;
            eprintln!(
                "{kind} smax={smax} written in {:.1}s; srsId=0x{}",
                t.elapsed().as_secs_f64(),
                hex::encode(srs.vk().id())
            );
        }
        Some("bench") => bench(&args)?,
        Some("prove") => prove_cmd(&args)?,
        Some("export-forge") => mania_gkr::forge::export(&args)?,
        Some("prove-session") => mania_gkr::forge::prove_session(&args)?,
        Some("prove-sealed") => mania_gkr::forge::prove_sealed(&args)?,
        Some("register-chart") => mania_gkr::forge::register_chart_command(&args)?,
        _ => bail!(
            "usage: mania-gkr srs --smax N --out FILE [--seed S | --ptau CEREMONY.ptau]\n       mania-gkr bench --srs FILE [--cases 500,3000ln] [--reps 3] [--out FILE]\n       mania-gkr prove --srs FILE --input PLAY.json [--mode a|b] [--out FILE]\n       mania-gkr export-forge --srs FILE --out DIR\n       mania-gkr prove-sealed --srs FILE --input PLAY.json [--mode a] [--header ABI_HEADER]\n       mania-gkr register-chart --srs FILE --input PLAY.json"
        ),
    }
    Ok(())
}
