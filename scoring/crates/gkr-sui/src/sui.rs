//! Sui glue: device signatures, Move test fixtures (`export-move`) and the sidecar commands
//! used by the localnet end-to-end script (`prepare-chart`, `prove-session`).
use crate::field::{fe_to_be, g1_to_bytes, g2_to_bytes, hex0x, G1Affine, Word, F, G1};
use crate::scoring::api;
use crate::scoring::encode::{decode, group_items, proof_bytes, proof_items};
use crate::scoring::session::{chart_bytes, register_chart, session_digest_v2};
use crate::scoring::{Mode, ScoreProof};
use crate::testutil::{benchmark_input, make_input, random_input};
use crate::transcript::keccak;
use crate::zeromorph::{self, Srs};
use anyhow::{bail, ensure, Context, Result};
use k256::ecdsa::SigningKey;
use mania_scoring_core::{
    chart_hash, evaluate, input_policy_hash, ruleset_id, session_digest, trace_root, Chart,
    InputEvent, PlayInput, SessionHeader,
};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    Ok(hex::decode(s.trim_start_matches("0x"))?)
}

fn unhex_n<const N: usize>(s: &str) -> Result<[u8; N]> {
    unhex(s)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected {N} bytes"))
}

/// Deterministic device key used by fixtures and the localnet demo (NOT a secret).
pub fn demo_device_key() -> SigningKey {
    SigningKey::from_bytes(&[0x42u8; 32].into()).unwrap()
}

/// Compressed secp256k1 public key (33 bytes), as registered on Sui.
pub fn device_pubkey(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_encoded_point(true).as_bytes().to_vec()
}

/// EVM-style device address keccak256(X ‖ Y)[12..]; the registry derives the same value.
pub fn device_address(key: &SigningKey) -> [u8; 20] {
    let p = key.verifying_key().to_encoded_point(false);
    keccak(&[&p.as_bytes()[1..]])[12..].try_into().unwrap()
}

/// 65-byte r ‖ s ‖ v (v ∈ {27, 28}, low-s) over the 32-byte session digest, exactly what the
/// SE050 produces for the EVM version. Sui checks it with `secp256k1_verify(…, SHA256)` over
/// the digest preimage.
pub fn sign_digest(key: &SigningKey, digest: &Word) -> [u8; 65] {
    let (sig, recid) = key.sign_prehash_recoverable(digest).unwrap();
    let (sig, recid) = match sig.normalize_s() {
        Some(n) => (n, k256::ecdsa::RecoveryId::from_byte(recid.to_byte() ^ 1).unwrap()),
        None => (sig, recid),
    };
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + recid.to_byte();
    out
}

pub fn events_bytes(events: &[InputEvent]) -> Vec<u8> {
    let mut out = Vec::with_capacity(14 * events.len());
    for e in events {
        out.extend(e.sequence.to_be_bytes());
        out.extend(e.timestamp_us.to_be_bytes());
        out.push(e.lane);
        out.push(e.action);
    }
    out
}

/// Fixture header: fixed session values, the demo device, V1 policy (api::prove swaps in V2).
fn fixture_header(chart: &Chart, device: [u8; 20]) -> SessionHeader {
    SessionHeader {
        chain_id: 0x5ec7,
        verifier: [0x5a; 20],
        match_id: [1; 32],
        session_id: [2; 32],
        challenge: [3; 32],
        player: [0x22; 20],
        device,
        chart_hash: chart_hash(chart),
        ruleset_id: ruleset_id(),
        bitstream_hash: [4; 32],
        input_policy_hash: input_policy_hash(),
    }
}

fn rebind(input: &PlayInput, header: SessionHeader) -> PlayInput {
    make_input(
        header,
        input.chart.clone(),
        input.events.clone(),
        input.footer.duration_us,
    )
}

/// Everything a submission needs, for one mode.
pub struct Prepared {
    pub proved: api::Proved,
    pub header: SessionHeader,
    pub input: PlayInput,
    pub digest: Word,
    pub sig: [u8; 65],
}

pub fn prepare(srs: &Srs, input: &PlayInput, mode: Mode, key: &SigningKey) -> Result<Prepared> {
    let reg = register_chart(srs, &input.chart)?;
    let proved = api::prove(srs, input, &reg.record, mode)?;
    let header = match mode {
        Mode::Calldata => input.header.clone(),
        Mode::Committed => api::mode_b_header(&input.header),
    };
    let digest = match mode {
        Mode::Calldata => session_digest(&header, &input.footer),
        Mode::Committed => session_digest_v2(
            &header,
            input.footer.event_count,
            input.footer.duration_us,
            &input.footer.trace_root,
            &proved.statement.trace_commitment.unwrap(),
        ),
    };
    ensure!(digest == proved.statement.session_digest, "digest mismatch");
    let sig = sign_digest(key, &digest);
    Ok(Prepared {
        proved,
        header,
        input: input.clone(),
        digest,
        sig,
    })
}

// ------------------------------------------------------------------ Move fixtures

/// PTB pure arguments are capped at 16 KiB; item lists travel in groups below that.
pub const GROUP_BYTES: usize = 15_000;

/// Device chunks of ≤32 events (the SP1 trace-chain unit), as `append_trace` takes them.
pub fn event_chunks(events: &[InputEvent]) -> Vec<Vec<u8>> {
    events
        .chunks(mania_scoring_core::CHUNK_EVENTS)
        .map(events_bytes)
        .collect()
}

/// Move literal of an item list, split into ≤32 KB pieces joined at run time (the compiler
/// folds constant vector literals and caps constants at 64 KiB).
fn mitems(items: &[Vec<u8>]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut size = 0;
    for it in items {
        if size + it.len() > 32_000 && !cur.is_empty() {
            parts.push(format!("keep(vector[{}])", cur.join(", ")));
            cur.clear();
            size = 0;
        }
        cur.push(format!("x\"{}\"", hex::encode(it)));
        size += it.len();
    }
    parts.push(if cur.is_empty() { "vector<vector<u8>>[]".to_string() } else { format!("keep(vector[{}])", cur.join(", ")) });
    let mut it = parts.into_iter();
    let first = it.next().unwrap();
    it.fold(first, |acc, p| format!("joinv({acc}, {p})"))
}

/// Move literal of item groups (`vector<vector<vector<u8>>>`).
fn mgroups(items: &[Vec<u8>]) -> String {
    let groups: Vec<String> = group_items(items, GROUP_BYTES).iter().map(|g| mitems(g)).collect();
    format!("vector[{}]", groups.join(", "))
}

/// Move byte-string literal; long values are split (the compiler caps constants at 64 KiB)
/// and flattened at run time.
fn mhex(b: &[u8]) -> String {
    const CHUNK: usize = 32_000;
    if b.len() <= CHUNK {
        return format!("x\"{}\"", hex::encode(b));
    }
    // Nested calls, not a vector literal: constant folding would re-merge the pieces.
    let mut parts = b.chunks(CHUNK).map(|c| format!("x\"{}\"", hex::encode(c)));
    let first = parts.next().unwrap();
    parts.fold(first, |acc, p| format!("join({acc}, {p})"))
}

fn mvec_u64(v: &[u64]) -> String {
    let items: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("vector[{}]", items.join(", "))
}

const CASE_FIELDS: &[(&str, &str)] = &[
    ("mode", "u8"),
    ("digest", "vector<u8>"),
    ("n", "u64"),
    ("duration", "u64"),
    ("chart_commitment", "vector<u8>"),
    ("m", "u64"),
    ("bits", "u64"),
    ("components", "u64"),
    ("max_end", "u64"),
    ("trace_commitment", "vector<u8>"),
    ("trace_root", "vector<u8>"),
    ("lane_bits", "vector<u64>"),
    ("counts", "vector<u64>"),
    ("proof", "vector<vector<vector<u8>>>"),
    ("sig", "vector<u8>"),
    ("judgements", "vector<u64>"),
    ("score", "u64"),
    ("chain_id", "u64"),
    ("verifier", "vector<u8>"),
    ("match_id", "vector<u8>"),
    ("session_id", "vector<u8>"),
    ("challenge", "vector<u8>"),
    ("player", "vector<u8>"),
    ("device", "vector<u8>"),
    ("chart_hash", "vector<u8>"),
    ("ruleset_id", "vector<u8>"),
    ("bitstream_hash", "vector<u8>"),
    ("input_policy_hash", "vector<u8>"),
];

fn case_literal(srs: &Srs, p: &Prepared) -> Result<String> {
    let st = &p.proved.statement;
    let reg = register_chart(srs, &p.input.chart)?;
    let reference = evaluate(&PlayInput {
        header: p.input.header.clone(),
        ..p.input.clone()
    })
    .map_err(anyhow::Error::msg)?;
    let h = &p.header;
    let judgements: Vec<u64> = reference.judgements.iter().map(|&x| x as u64).collect();
    let values: Vec<String> = vec![
        format!("{}", st.mode as u8),
        mhex(&p.digest),
        st.n.to_string(),
        st.duration.to_string(),
        mhex(&g1_to_bytes(&reg.record.commitment)),
        reg.record.m.to_string(),
        reg.record.bits.to_string(),
        reg.record.components.to_string(),
        reg.record.max_end.to_string(),
        mhex(&st.trace_commitment.map(|c| g1_to_bytes(&c).to_vec()).unwrap_or_default()),
        mhex(&p.input.footer.trace_root),
        mvec_u64(&p.proved.proof.lane_bits),
        mvec_u64(&p.proved.proof.counts),
        mgroups(&proof_items(&p.proved.proof)),
        mhex(&p.sig),
        mvec_u64(&judgements),
        reference.score.to_string(),
        h.chain_id.to_string(),
        mhex(&h.verifier),
        mhex(&h.match_id),
        mhex(&h.session_id),
        mhex(&h.challenge),
        mhex(&h.player),
        mhex(&h.device),
        mhex(&h.chart_hash),
        mhex(&h.ruleset_id),
        mhex(&h.bitstream_hash),
        mhex(&h.input_policy_hash),
    ];
    let mut s = String::from("    Case {\n");
    for ((name, _), v) in CASE_FIELDS.iter().zip(values) {
        writeln!(s, "        {name}: {v},")?;
    }
    s.push_str("    }\n");
    Ok(s)
}

/// Proofs that must be rejected: every section perturbed, plus truncation/extension.
fn tampered(p: &ScoreProof, chart_bits: u64, n: u64, mode: Mode) -> Result<Vec<(String, Vec<Vec<u8>>)>> {
    let items = proof_items(p);
    let back = decode(&items, p.lane_bits, p.counts, chart_bits, n, mode)?;
    ensure!(&back == p, "encoding round-trip");
    let other = |q: &G1Affine| -> G1Affine {
        use crate::field::{Curve, PrimeCurveAffine};
        (q.to_curve() + G1::generator()).to_affine()
    };
    let one = F::from(1);
    let mut out: Vec<(String, ScoreProof)> = Vec::new();
    let mut t = |name: &str, f: &dyn Fn(&mut ScoreProof)| {
        let mut q = p.clone();
        f(&mut q);
        out.push((name.into(), q));
    };
    t("adv_commitment", &|q| q.adv_commitment = other(&q.adv_commitment));
    t("gkr_layer1", &|q| q.gkr.layer1[1] += one);
    t("gkr_round", &|q| q.gkr.layers[2].rounds[1][0] += one);
    t("gkr_children", &|q| {
        let l = q.gkr.layers.len() - 1;
        q.gkr.layers[l].children[3] += one
    });
    t("row_round", &|q| q.row_rounds[3][2] += one);
    t("claim_first", &|q| q.claims[0] += one);
    t("claim_last", &|q| {
        let l = q.claims.len() - 1;
        q.claims[l] += one
    });
    t("red_round", &|q| q.red_rounds[5][1] += one);
    t("adv_eval", &|q| q.adv_eval += one);
    t("chart_eval", &|q| q.chart_eval += one);
    if mode == Mode::Committed {
        t("trace_eval", &|q| *q.trace_eval.as_mut().unwrap() += one);
    }
    t("zm_q0", &|q| q.zm.q[0] = other(&q.zm.q[0]));
    t("zm_qhat", &|q| q.zm.qhat = other(&q.zm.qhat));
    t("zm_qhat_shift", &|q| q.zm.qhat_shift = other(&q.zm.qhat_shift));
    t("zm_pi", &|q| q.zm.pi = other(&q.zm.pi));
    let mut res: Vec<(String, Vec<Vec<u8>>)> = out.iter().map(|(n, q)| (n.clone(), proof_items(q))).collect();
    res.push(("truncated".into(), items[..items.len() - 1].to_vec()));
    let mut ext = items.clone();
    ext.push(vec![0u8; 32]);
    res.push(("extended".into(), ext));
    let mut noncanon = items.clone();
    // First GKR scalar := r (non-canonical encoding of 0).
    noncanon[1] = {
        let mut r = fe_to_be(&(-F::from(1)));
        r[31] += 1;
        r.to_vec()
    };
    res.push(("noncanonical".into(), noncanon));
    Ok(res)
}

/// `export-move --srs FILE --out MOVE_PKG [--heavy]`: writes tests/fixtures.move and
/// tests/generated_tests.move for `sui move test`.
pub fn export_move(args: &[String]) -> Result<()> {
    let srs = Srs::load(Path::new(&arg(args, "--srs").context("missing --srs")?))?;
    let out = PathBuf::from(arg(args, "--out").context("missing --out")?);
    let heavy = args.iter().any(|a| a == "--heavy");
    let key = demo_device_key();
    let dev = device_address(&key);
    let vk = srs.vk();

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let load = |f: &str| -> Result<PlayInput> {
        Ok(serde_json::from_slice(&std::fs::read(fixtures.join(f))?)?)
    };
    let mut plays: Vec<(String, PlayInput, Vec<Mode>)> = vec![
        ("demo".into(), load("demo.json")?, vec![Mode::Calldata, Mode::Committed]),
        ("perfect".into(), load("perfect.json")?, vec![Mode::Calldata, Mode::Committed]),
    ];
    let mut seed = 0u64;
    let mut found = 0;
    while found < 2 {
        let input = random_input(seed);
        if evaluate(&input).is_ok() && input.events.len() > 10 {
            let mode = if found == 0 { Mode::Calldata } else { Mode::Committed };
            plays.push((format!("random{seed}"), input, vec![mode]));
            found += 1;
        }
        seed += 1;
    }
    plays.push(("bench500".into(), benchmark_input(500, false), vec![Mode::Calldata, Mode::Committed]));
    plays.push(("bench3000".into(), benchmark_input(3000, false), vec![Mode::Calldata, Mode::Committed]));
    if heavy {
        plays.push(("spam10k".into(), spam_worst_case(), vec![Mode::Committed]));
    }

    let mut fx = String::new();
    fx.push_str("// @generated by `mania-gkr-sui export-move`; do not edit.\n#[test_only]\nmodule mania_gkr::fixtures;\n\n");
    fx.push_str("fun join(mut a: vector<u8>, b: vector<u8>): vector<u8> {\n    a.append(b);\n    a\n}\n\n");
    fx.push_str("fun joinv(mut a: vector<vector<u8>>, b: vector<vector<u8>>): vector<vector<u8>> {\n    a.append(b);\n    a\n}\n\n");
    fx.push_str("/// Identity; a call is not constant-folded into an oversized literal.\nfun keep(a: vector<vector<u8>>): vector<vector<u8>> { a }\n\n");
    fx.push_str("public struct Case has copy, drop {\n");
    for (name, ty) in CASE_FIELDS {
        writeln!(fx, "    {name}: {ty},")?;
    }
    fx.push_str("}\n\n");
    for (name, ty) in CASE_FIELDS {
        writeln!(fx, "public fun {name}(c: &Case): {ty} {{ c.{name} }}")?;
    }
    writeln!(fx, "\npublic fun vk_g2_tau(): vector<u8> {{ {} }}", mhex(&g2_to_bytes(&vk.g2_tau)))?;
    let shifts: Vec<String> = vk.g2_shift.iter().map(|p| mhex(&g2_to_bytes(p))).collect();
    writeln!(fx, "\npublic fun vk_g2_shift(): vector<vector<u8>> {{\n    vector[\n        {},\n    ]\n}}", shifts.join(",\n        "))?;
    writeln!(fx, "\npublic fun srs_id(): vector<u8> {{ {} }}", mhex(&vk.id()))?;
    writeln!(fx, "\npublic fun device_pubkey(): vector<u8> {{ {} }}", mhex(&device_pubkey(&key)))?;
    writeln!(fx, "\npublic fun device_address(): vector<u8> {{ {} }}", mhex(&dev))?;

    let mut tests = String::new();
    tests.push_str("// @generated by `mania-gkr-sui export-move`; do not edit.\n#[test_only]\nmodule mania_gkr::generated_tests;\n\nuse mania_gkr::fixtures;\nuse mania_gkr::test_util;\n");
    // Large data lives in separate functions so a test only builds what it uses (a unit
    // test runs under one 5M-unit gas meter, fixture construction included).
    for (name, play, modes) in &plays {
        let input = rebind(play, fixture_header(&play.chart, dev));
        let reg = register_chart(&srs, &input.chart)?;
        let m = input.chart.notes.len();
        let n = input.events.len();
        writeln!(fx, "\npublic fun chart_bytes_{name}(): vector<u8> {{ {} }}", mhex(&chart_bytes(&input.chart)))?;
        writeln!(fx, "\npublic fun chart_proof_{name}(): vector<vector<vector<u8>>> {{ {} }}", mgroups(&zeromorph::proof_items(&reg.proof)))?;
        let first = format!("{name}_{}", if modes[0] == Mode::Calldata { "a" } else { "b" });
        if m <= 3000 {
            writeln!(tests, "\n#[test]\nfun chart_{name}() {{\n    test_util::check_chart(&fixtures::case_{first}(), fixtures::chart_bytes_{name}(), fixtures::chart_proof_{name}());\n}}")?;
        }
        // Real chart check / trace upload inside submit tests only for small inputs.
        let chart_args = if m <= 64 {
            format!("fixtures::chart_bytes_{name}(), fixtures::chart_proof_{name}()")
        } else {
            "vector[], vector[]".into()
        };
        for &mode in modes {
            let a = mode == Mode::Calldata;
            let tag = format!("{name}_{}", if a { "a" } else { "b" });
            let p = prepare(&srs, &input, mode, &key)?;
            eprintln!(
                "case {tag}: {} events, proof {} B, prove {:.0} ms",
                n,
                proof_bytes(&p.proved.proof).len(),
                p.proved.timings.total_ms
            );
            writeln!(fx, "\npublic fun case_{tag}(): Case {{\n{}}}", case_literal(&srs, &p)?)?;
            let trace_args = if a {
                writeln!(fx, "\npublic fun events_{tag}(): vector<vector<u8>> {{ {} }}", mitems(&event_chunks(&input.events)))?;
                let ts: Vec<Vec<u8>> = input.events.iter().map(|e| fe_to_be(&F::from(e.timestamp_us)).to_vec()).collect();
                writeln!(fx, "\npublic fun trace_t_{tag}(): vector<vector<u8>> {{ {} }}", mitems(&ts))?;
                let la: Vec<u8> = input.events.iter().map(|e| e.lane | (e.action << 2)).collect();
                writeln!(fx, "\npublic fun trace_la_{tag}(): vector<u8> {{ {} }}", mhex(&la))?;
                format!("fixtures::trace_t_{tag}(), fixtures::trace_la_{tag}()")
            } else {
                "vector[], vector[]".into()
            };
            let events_arg = if a && n <= 256 { format!("fixtures::events_{tag}()") } else { "vector[]".into() };
            writeln!(tests, "\n#[test]\nfun verify_{tag}() {{\n    test_util::check_verify(&fixtures::case_{tag}(), {trace_args});\n}}")?;
            writeln!(tests, "\n#[test]\nfun submit_{tag}() {{\n    test_util::check_submit(&fixtures::case_{tag}(), {chart_args}, {events_arg}, {trace_args});\n}}")?;
            if a {
                writeln!(tests, "\n#[test]\nfun upload_{tag}() {{\n    test_util::check_upload(&fixtures::case_{tag}(), fixtures::events_{tag}());\n}}")?;
            }
            if name == "demo" {
                let bad = tampered(&p.proved.proof, p.proved.statement.chart.bits, p.proved.statement.n, mode)?;
                // One function per proof: a vector literal would be folded into one oversized constant.
                for (what, b) in &bad {
                    writeln!(fx, "\npublic fun tampered_{tag}_{what}(): vector<vector<vector<u8>>> {{ {} }}", mgroups(b))?;
                    writeln!(tests, "\n#[test, expected_failure]\nfun reject_{tag}_{what}() {{\n    test_util::check_verify_proof(&fixtures::case_{tag}(), fixtures::tampered_{tag}_{what}(), {trace_args});\n}}")?;
                }
            }
        }
    }
    std::fs::create_dir_all(out.join("tests"))?;
    std::fs::write(out.join("tests/fixtures.move"), fx)?;
    std::fs::write(out.join("tests/generated_tests.move"), tests)?;
    Ok(())
}

/// Worst case of the spam benchmark: 10,000 notes in lane 0 and 50,000 lane-0 events.
pub fn spam_worst_case() -> PlayInput {
    use mania_scoring_core::Note;
    let notes: Vec<Note> = (0..10_000u64)
        .map(|i| {
            let s = 1_000_000 + i * 150_000;
            Note { lane: 0, start_us: s, end_us: s + if i % 4 == 0 { 100_000 } else { 0 } }
        })
        .collect();
    let chart = Chart { key_count: 4, notes };
    let end = chart.notes.last().unwrap().end_us + 136_500;
    let n = 50_000u64;
    let events: Vec<InputEvent> = (0..n)
        .map(|i| InputEvent {
            sequence: i as u32,
            timestamp_us: end * i / n,
            lane: 0,
            action: (i % 2) as u8,
        })
        .collect();
    let header = fixture_header(&chart, [0; 20]);
    make_input(header, chart, events, end)
}

// ------------------------------------------------------------------ sidecar commands

/// `prepare-chart --srs FILE --input PLAY.json`: chart bytes, commitment and registration proof.
pub fn prepare_chart(args: &[String]) -> Result<()> {
    let srs = Srs::load(Path::new(&arg(args, "--srs").context("missing --srs")?))?;
    let input: PlayInput = serde_json::from_slice(&std::fs::read(arg(args, "--input").context("missing --input")?)?)?;
    let reg = register_chart(&srs, &input.chart)?;
    let vk = srs.vk();
    let shifts: Vec<String> = vk.g2_shift.iter().map(|p| hex0x(&g2_to_bytes(p))).collect();
    println!(
        "{}",
        json!({
            "chartBytes": hex0x(&chart_bytes(&input.chart)),
            "chartHash": hex0x(&reg.chart_hash),
            "commitment": hex0x(&g1_to_bytes(&reg.record.commitment)),
            "proof": zeromorph::proof_items(&reg.proof).iter().map(|b| hex0x(b)).collect::<Vec<_>>(),
            "vk": { "g2Tau": hex0x(&g2_to_bytes(&vk.g2_tau)), "g2Shift": shifts, "srsId": hex0x(&vk.id()) },
            "devicePubkey": hex0x(&device_pubkey(&demo_device_key())),
            "deviceAddress": hex0x(&device_address(&demo_device_key())),
        })
    );
    Ok(())
}

fn header_from_json(v: &Value) -> Result<SessionHeader> {
    let s = |k: &str| -> Result<String> {
        Ok(v[k].as_str().with_context(|| format!("header.{k}"))?.to_string())
    };
    Ok(SessionHeader {
        chain_id: v["chainId"].as_str().map(|x| x.parse()).transpose()?.or(v["chainId"].as_u64()).context("header.chainId")?,
        verifier: unhex_n(&s("verifier")?)?,
        match_id: unhex_n(&s("matchId")?)?,
        session_id: unhex_n(&s("sessionId")?)?,
        challenge: unhex_n(&s("challenge")?)?,
        player: unhex_n(&s("player")?)?,
        device: unhex_n(&s("device")?)?,
        chart_hash: unhex_n(&s("chartHash")?)?,
        ruleset_id: unhex_n(&s("rulesetId")?)?,
        bitstream_hash: unhex_n(&s("bitstreamHash")?)?,
        input_policy_hash: unhex_n(&s("inputPolicyHash")?)?,
    })
}

/// `prove-session --srs FILE --input PLAY.json --mode a|b --header HEADER.json`
/// Rebinds the recorded play to the on-chain session header (a real device would record
/// against it), proves, signs with the demo device key and prints the submission as JSON.
pub fn prove_session(args: &[String]) -> Result<()> {
    let srs = Srs::load(Path::new(&arg(args, "--srs").context("missing --srs")?))?;
    let play: PlayInput = serde_json::from_slice(&std::fs::read(arg(args, "--input").context("missing --input")?)?)?;
    let mode = match arg(args, "--mode").as_deref() {
        Some("a") => Mode::Calldata,
        Some("b") => Mode::Committed,
        _ => bail!("--mode a|b"),
    };
    let hv: Value = serde_json::from_slice(&std::fs::read(arg(args, "--header").context("missing --header")?)?)?;
    let mut header = header_from_json(&hv)?;
    // The on-chain header carries the mode's policy; proving starts from the V1 form.
    header.input_policy_hash = input_policy_hash();
    let input = rebind(&play, header);
    ensure!(input.footer.trace_root == trace_root(&input.header.session_id, &input.events));
    let p = prepare(&srs, &input, mode, &demo_device_key())?;
    let st = &p.proved.statement;
    println!(
        "{}",
        json!({
            "mode": mode as u8,
            "n": st.n,
            "duration": st.duration,
            "traceRoot": hex0x(&input.footer.trace_root),
            "traceCommitment": hex0x(&st.trace_commitment.map(|c| g1_to_bytes(&c).to_vec()).unwrap_or_default()),
            "laneBits": p.proved.proof.lane_bits,
            "counts": p.proved.proof.counts,
            "eventChunks": event_chunks(&input.events).iter().map(|b| hex0x(b)).collect::<Vec<_>>(),
            "proof": proof_items(&p.proved.proof).iter().map(|b| hex0x(b)).collect::<Vec<_>>(),
            "proofBytes": proof_bytes(&p.proved.proof).len(),
            "sig": hex0x(&p.sig),
            "sessionDigest": hex0x(&p.digest),
            "proveMs": p.proved.timings.total_ms,
            "expectedScore": evaluate(&input).map_err(anyhow::Error::msg)?.score,
        })
    );
    Ok(())
}
