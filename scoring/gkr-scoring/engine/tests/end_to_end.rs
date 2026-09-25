use mania_gkr::field::{Field, F};
use mania_gkr::scoring::api::{self, Proved};
use mania_gkr::scoring::session::{register_chart, verify_chart_registration};
use mania_gkr::scoring::{witness, ChartRecord, Mode};
use mania_gkr::testutil::{benchmark_input, random_input};
use mania_gkr::zeromorph::Srs;
use mania_scoring_core::{evaluate, PlayInput};
use std::sync::OnceLock;

fn srs() -> &'static Srs {
    static SRS: OnceLock<Srs> = OnceLock::new();
    SRS.get_or_init(|| Srs::insecure_dev(18, 7))
}

fn fixture(name: &str) -> PlayInput {
    let path = format!(
        "{}/../../sp1-scoring/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn chart_record(input: &PlayInput) -> ChartRecord {
    let reg = register_chart(srs(), &input.chart).unwrap();
    let rec = verify_chart_registration(
        &srs().vk(),
        &input.chart,
        &reg.record.commitment,
        &reg.proof,
    )
    .unwrap();
    assert_eq!(rec.components, reg.record.components);
    rec
}

fn prove_and_check(input: &PlayInput, mode: Mode) -> Proved {
    let record = chart_record(input);
    let proved = api::prove(srs(), input, &record, mode).unwrap();
    let events = (mode == Mode::Calldata).then_some(&input.events[..]);
    let res = api::verify(&srs().vk(), &proved.statement, &proved.proof, events).unwrap();
    let reference = evaluate(input).unwrap();
    assert_eq!(res.score, reference.score as u64);
    assert_eq!(res.achieved_points, reference.achieved_points);
    assert_eq!(res.maximum_points, reference.maximum_points);
    assert_eq!(
        res.judgements.to_vec(),
        reference
            .judgements
            .iter()
            .map(|&x| x as u64)
            .collect::<Vec<_>>()
    );
    proved
}

#[test]
fn sp1_fixtures_both_modes() {
    for name in ["demo.json", "perfect.json"] {
        let input = fixture(name);
        prove_and_check(&input, Mode::Calldata);
        prove_and_check(&input, Mode::Committed);
    }
}

#[test]
fn benchmark_shapes_small() {
    for (count, ln) in [(64, false), (64, true), (257, false)] {
        prove_and_check(&benchmark_input(count, ln), Mode::Calldata);
    }
}

#[test]
fn tampering_is_rejected() {
    let input = fixture("demo.json");
    let proved = prove_and_check(&input, Mode::Calldata);
    let vk = srs().vk();
    let ev = Some(&input.events[..]);
    let ok = |p: &mania_gkr::scoring::ScoreProof, st: &mania_gkr::scoring::Statement| {
        api::verify(&vk, st, p, ev).is_ok()
    };
    let (st, proof) = (&proved.statement, &proved.proof);
    assert!(ok(proof, st));

    let mut p = proof.clone();
    p.counts[0] += 1; // claim one more PERFECT
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.counts[1] -= 1;
    p.counts[0] += 1; // GREAT -> PERFECT
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.claims[3] += F::ONE;
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.row_rounds[0][1] += F::ONE;
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.red_rounds[2][0] += F::ONE;
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.adv_eval += F::ONE;
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.gkr.layer1[0] += F::ONE;
    assert!(!ok(&p, st));
    let mut p = proof.clone();
    p.lane_bits[0] += 1;
    assert!(!ok(&p, st));

    let mut s = st.clone();
    s.session_digest[0] ^= 1;
    assert!(!ok(proof, &s));
    let mut s = st.clone();
    s.duration += 1;
    assert!(!ok(proof, &s));
    // A different (valid) trace with the same statement: mode A binds the calldata trace.
    let mut other = input.events.clone();
    other[1].timestamp_us += 1;
    assert!(api::verify(&vk, st, proof, Some(&other)).is_err());
    // Same proof, different chart record.
    let mut s = st.clone();
    s.chart.components += 1;
    assert!(!ok(proof, &s));
}

#[test]
fn mode_b_binds_device_commitment() {
    let input = fixture("demo.json");
    let proved = prove_and_check(&input, Mode::Committed);
    let vk = srs().vk();
    let mut other = input.clone();
    other.events[1].timestamp_us += 1;
    let mut s = proved.statement.clone();
    s.trace_commitment = Some(api::device_trace_commitment(srs(), &other.events));
    assert!(api::verify(&vk, &s, &proved.proof, None).is_err());
}

#[test]
fn invalid_traces_cannot_be_proven() {
    let mut input = fixture("demo.json");
    input.events.swap(0, 1); // breaks sequence/time order
    for (i, e) in input.events.iter_mut().enumerate() {
        e.sequence = i as u32;
    }
    assert!(witness::build_from_input(&input).is_err() || evaluate(&input).is_err());
}

#[test]
fn differential_random_corpus() {
    // Witness construction re-derives counts via the timeline and compares against
    // core::evaluate; a subset is fully proven and verified.
    let mut valid = 0;
    let mut invalid = 0;
    for seed in 0..3000u64 {
        let input = random_input(seed);
        match (evaluate(&input), witness::build_from_input(&input)) {
            (Ok(_), Ok(_)) => valid += 1,
            (Err(_), Err(_)) => invalid += 1,
            (a, b) => panic!(
                "seed {seed}: reference {:?} vs witness {:?}",
                a.map(|x| x.judgements),
                b.map(|w| w.counts)
            ),
        }
        if seed % 60 == 0 && evaluate(&input).is_ok() {
            let mode = if seed % 120 == 0 {
                Mode::Committed
            } else {
                Mode::Calldata
            };
            prove_and_check(&input, mode);
        }
    }
    assert!(
        valid > 1500 && invalid > 50,
        "valid={valid} invalid={invalid}"
    );
}

#[test]
fn malicious_witnesses_are_rejected() {
    use mania_gkr::scoring::prover;
    use mania_gkr::scoring::relation::{chart as ch, lane as ln, Kind};
    let input = fixture("demo.json");
    let record = chart_record(&input);
    let honest = witness::build_from_input(&input).unwrap();
    let st = api::statement(&input, &record, Mode::Calldata, srs().vk().id(), None);
    let vk = srs().vk();
    let check = |w: &witness::Witness| -> bool {
        let (proof, _) = prover::prove(w, &st, srs(), &input.events).unwrap();
        api::verify(&vk, &st, &proof, Some(&input.events[..])).is_ok()
    };
    assert!(check(&honest));
    // The GREAT head in lane 1 claimed as PERFECT (counts adjusted to match).
    let lane1_note = 1; // global chart row of the lane-1 hold in demo.json
    let mut w = honest.clone();
    let t = &mut w.tables[Kind::Chart.index()];
    let great_is_head = t.cols[ch::H0 + 1][lane1_note] == F::ONE;
    if great_is_head {
        t.cols[ch::H0 + 1][lane1_note] = F::ZERO;
        t.cols[ch::H0][lane1_note] = F::ONE;
    } else {
        t.cols[ch::G0 + 1][lane1_note] = F::ZERO;
        t.cols[ch::G0][lane1_note] = F::ONE;
    }
    w.counts[1] -= 1;
    w.counts[0] += 1;
    assert!(!check(&w), "class forgery accepted");
    // Claim a hit note as missed (drop one PERFECT).
    let mut w = honest.clone();
    let t = &mut w.tables[Kind::Chart.index()];
    t.cols[ch::HIT][0] = F::ZERO;
    t.cols[ch::H0][0] = F::ZERO;
    w.counts[0] -= 1;
    assert!(!check(&w), "dropped hit accepted");
    // Lane 0: pretend the DOWN did not consume the front note.
    let mut w = honest.clone();
    let t = &mut w.tables[Kind::Lane(0).index()];
    let down = (0..t.rows())
        .find(|&r| t.cols[ln::MD][r] == F::ONE)
        .unwrap();
    t.cols[ln::MD][down] = F::ZERO;
    assert!(!check(&w), "match suppression accepted");
    // Swap two timeline rows (breaks sort order / state chaining).
    let mut w = honest.clone();
    let t = &mut w.tables[Kind::Lane(2).index()];
    for c in 0..ln::ADV {
        t.cols[c].swap(0, 1);
    }
    assert!(!check(&w), "row reordering accepted");
    // Out-of-range limb (byte multiplicity recomputed would still fail the recomposition).
    let mut w = honest.clone();
    let t = &mut w.tables[Kind::Trace.index()];
    t.cols[1][0] += F::from(256);
    assert!(!check(&w), "limb forgery accepted");
}

#[test]
fn honest_witnesses_satisfy_relation() {
    for seed in 0..3000u64 {
        let input = random_input(seed);
        if let Ok(w) = witness::build_from_input(&input) {
            let v = witness::check(&w);
            assert!(
                v.is_empty(),
                "seed {seed}: {:?}\n{:?}",
                &v[..v.len().min(8)],
                input
            );
        }
    }
}

#[test]
fn proof_encoding_roundtrip() {
    use mania_gkr::scoring::encode;
    let input = fixture("demo.json");
    for mode in [Mode::Calldata, Mode::Committed] {
        let proved = prove_and_check(&input, mode);
        let words = encode::proof_words(&proved.proof);
        let back = encode::decode(
            &words,
            proved.proof.lane_bits,
            proved.proof.counts,
            proved.statement.chart.bits,
            proved.statement.n,
            mode,
        )
        .unwrap();
        assert_eq!(back, proved.proof);
        let mut bad = words.clone();
        bad[5] = [0xff; 32]; // non-canonical
        assert!(encode::decode(
            &bad,
            proved.proof.lane_bits,
            proved.proof.counts,
            proved.statement.chart.bits,
            proved.statement.n,
            mode
        )
        .is_err());
    }
}
