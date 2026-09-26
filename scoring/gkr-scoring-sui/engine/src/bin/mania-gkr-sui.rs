//! CLI: dev SRS generation, proving/verifying, benchmarks, Move fixture export, Sui sidecar.
use anyhow::{bail, Context, Result};
use mania_gkr_sui::field::{g1_to_bytes, hex0x};
use mania_gkr_sui::scoring::api;
use mania_gkr_sui::scoring::encode;
use mania_gkr_sui::scoring::prover::shape_of;
use mania_gkr_sui::scoring::session::register_chart;
use mania_gkr_sui::scoring::Mode;
use mania_gkr_sui::testutil::benchmark_input;
use mania_gkr_sui::zeromorph::Srs;
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
            let proof_len = encode::proof_bytes(&p.proof).len();
            let row = json!({
                "case": case, "mode": format!("{mode:?}"), "notes": count, "events": input.events.len(),
                "score": res.score, "tableBits": shape.bits, "leafVars": g, "openingVars": shape.opening_vars(),
                "proveMsMedian": median(totals.clone()), "proveMsAll": totals, "lastTimings": p.timings,
                "verifyNativeMsMedian": median(vt), "proofBytes": proof_len,
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
    let proof = encode::proof_bytes(&p.proof);
    let out = json!({
        "mode": format!("{mode:?}"), "result": res, "timings": p.timings, "srsLoadMs": srs_ms,
        "laneBits": p.proof.lane_bits, "counts": p.proof.counts, "proof": hex0x(&proof),
        "chartCommitment": hex0x(&g1_to_bytes(&reg.record.commitment)),
        "traceCommitment": p.statement.trace_commitment.map(|c| hex0x(&g1_to_bytes(&c))),
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
            let (srs, kind) = (Srs::insecure_dev(smax, seed), "INSECURE dev SRS (known tau)");
            srs.save(&PathBuf::from(need(&args, "--out")?))?;
            eprintln!(
                "{kind} smax={smax} written in {:.1}s; srsId=0x{}",
                t.elapsed().as_secs_f64(),
                hex::encode(srs.vk().id())
            );
        }
        Some("bench") => bench(&args)?,
        Some("prove") => prove_cmd(&args)?,
        Some("play") => {
            // Synthetic plays: benchN / benchNln (perfect play), spam10k (worst-case spam).
            let case = need(&args, "--case")?;
            let input = if case == "spam10k" {
                mania_gkr_sui::sui::spam_worst_case()
            } else {
                let rest = case.trim_start_matches("bench");
                benchmark_input(rest.trim_end_matches("ln").parse()?, rest.ends_with("ln"))
            };
            std::fs::write(need(&args, "--out")?, serde_json::to_string(&input)?)?;
        }
        Some("export-move") => mania_gkr_sui::sui::export_move(&args)?,
        Some("prepare-chart") => mania_gkr_sui::sui::prepare_chart(&args)?,
        Some("prove-session") => mania_gkr_sui::sui::prove_session(&args)?,
        _ => bail!(
            "usage: mania-gkr-sui srs --smax N --out FILE [--seed S]\n       mania-gkr-sui bench --srs FILE [--cases 500,3000ln] [--reps 3] [--out FILE]\n       mania-gkr-sui prove --srs FILE --input PLAY.json [--mode a|b] [--out FILE]\n       mania-gkr-sui play --case bench3000|spam10k --out PLAY.json\n       mania-gkr-sui export-move --srs FILE --out MOVE_PKG [--heavy]\n       mania-gkr-sui prepare-chart --srs FILE --input PLAY.json\n       mania-gkr-sui prove-session --srs FILE --input PLAY.json --mode a|b --header HEADER.json"
        ),
    }
    Ok(())
}
