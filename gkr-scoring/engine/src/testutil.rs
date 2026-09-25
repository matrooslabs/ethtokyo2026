//! Deterministic synthetic inputs shared by tests, benchmarks and fixture export.
use mania_scoring_core::{
    chart_hash, input_policy_hash, ruleset_id, trace_root, Chart, InputEvent, Note, PlayInput,
    SessionFooter, SessionHeader,
};
use rand::{Rng, SeedableRng};

pub fn header_for(chart: &Chart) -> SessionHeader {
    SessionHeader {
        chain_id: 31337,
        verifier: [17; 20],
        match_id: [1; 32],
        session_id: [2; 32],
        challenge: [3; 32],
        player: [34; 20],
        device: [51; 20],
        chart_hash: chart_hash(chart),
        ruleset_id: ruleset_id(),
        bitstream_hash: [4; 32],
        input_policy_hash: input_policy_hash(),
    }
}

pub fn make_input(
    header: SessionHeader,
    chart: Chart,
    events: Vec<InputEvent>,
    duration: u64,
) -> PlayInput {
    let footer = SessionFooter {
        event_count: events.len() as u32,
        duration_us: duration,
        trace_root: trace_root(&header.session_id, &events),
    };
    PlayInput {
        header,
        footer,
        chart,
        events,
    }
}

/// Mirrors sp1-scoring/scripts/benchmark.py: evenly spaced notes hit perfectly.
pub fn benchmark_input(count: usize, ln_heavy: bool) -> PlayInput {
    let mut notes = Vec::with_capacity(count);
    for i in 0..count {
        let start = 1_000_000 + i as u64 * 150_000;
        let hold = ln_heavy || i % 4 == 0;
        notes.push(Note {
            lane: (i % 4) as u8,
            start_us: start,
            end_us: start + if hold { 300_000 } else { 0 },
        });
    }
    perfect_play(notes)
}

pub fn perfect_play(notes: Vec<Note>) -> PlayInput {
    let mut edges: Vec<(u64, u8, u8)> = Vec::new();
    for n in &notes {
        let up = if n.end_us > n.start_us {
            n.end_us
        } else {
            n.start_us + 1
        };
        edges.push((n.start_us, n.lane, 0));
        edges.push((up, n.lane, 1));
    }
    // UP before DOWN at equal time permits adjacent taps.
    edges.sort_by_key(|&(t, lane, act)| (t, lane, std::cmp::Reverse(act)));
    let events: Vec<InputEvent> = edges
        .iter()
        .enumerate()
        .map(|(i, &(t, lane, action))| InputEvent {
            sequence: i as u32,
            timestamp_us: t,
            lane,
            action,
        })
        .collect();
    let chart = Chart {
        key_count: 4,
        notes,
    };
    let duration = chart.notes.iter().map(|n| n.end_us).max().unwrap() + 136_500;
    make_input(header_for(&chart), chart, events, duration)
}

/// Random chart and trace. `validish` biases events around notes; some traces are invalid.
pub fn random_input(seed: u64) -> PlayInput {
    let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);
    let mut notes: Vec<Note> = Vec::new();
    let mut last_end = [None::<u64>; 4];
    let mut t: u64 = rng.gen_range(0..300_000);
    let target = rng.gen_range(1..40);
    for _ in 0..target * 3 {
        if notes.len() >= target {
            break;
        }
        t += match rng.gen_range(0..4) {
            0 | 1 => 0,
            2 => 1,
            _ => rng.gen_range(1..200_000),
        };
        let lane = rng.gen_range(0..4u8);
        if last_end[lane as usize].is_some_and(|e| t <= e) {
            continue;
        }
        if notes.iter().any(|n| n.start_us == t && n.lane == lane) {
            continue;
        }
        let end = if rng.gen_bool(0.6) {
            t
        } else {
            t + rng.gen_range(1..400_000)
        };
        notes.push(Note {
            lane,
            start_us: t,
            end_us: end,
        });
        last_end[lane as usize] = Some(end);
    }
    if notes.is_empty() {
        notes.push(Note {
            lane: 0,
            start_us: 500_000,
            end_us: 500_000,
        });
    }
    notes.sort_by_key(|n| (n.start_us, n.lane));
    let end = notes.iter().map(|n| n.end_us).max().unwrap();
    let duration = end
        + 136_500
        + if rng.gen_bool(0.5) {
            0
        } else {
            rng.gen_range(0..300_000)
        };
    let mut cand: Vec<(u64, u8, u8)> = Vec::new();
    if rng.gen_bool(0.7) {
        for n in &notes {
            let jitter = |rng: &mut rand_chacha::ChaCha20Rng| rng.gen_range(-160_000i64..160_000);
            let d = (n.start_us as i64 + jitter(&mut rng)).max(0) as u64;
            let base_up = if n.end_us > n.start_us {
                n.end_us as i64
            } else {
                d as i64 + 1
            };
            let u = (base_up + jitter(&mut rng)).max(d as i64) as u64;
            // Boundary probes around every window edge.
            let d = if rng.gen_bool(0.2) {
                let w = [
                    19_500i64, 19_501, 49_500, 49_501, 82_500, 82_501, 112_500, 112_501, 136_500,
                    136_501,
                ][rng.gen_range(0..10)];
                (n.start_us as i64 + if rng.gen_bool(0.5) { w } else { -w }).max(0) as u64
            } else {
                d
            };
            cand.push((d, n.lane, 0));
            cand.push((u.max(d), n.lane, 1));
            if rng.gen_bool(0.3) {
                let x = (n.start_us as i64 + rng.gen_range(-200_000i64..200_000)).max(0) as u64;
                cand.push((x, n.lane, 0));
                cand.push((x + rng.gen_range(0..50_000), n.lane, 1));
            }
        }
    } else {
        let mut tt = 0u64;
        for _ in 0..rng.gen_range(0..60) {
            tt += match rng.gen_range(0..4) {
                0 | 1 => 0,
                2 => 1,
                _ => rng.gen_range(0..120_000),
            };
            cand.push((tt, rng.gen_range(0..4), rng.gen_range(0..2)));
        }
    }
    cand.sort_by_key(|&(t, _, act)| (t, act));
    let mut held = [0u8; 4];
    let allow_invalid = rng.gen_bool(0.15);
    let mut events = Vec::new();
    for (t, lane, act) in cand {
        if t > duration && !(allow_invalid && rng.gen_bool(0.05)) {
            continue;
        }
        if held[lane as usize] != act && !(allow_invalid && rng.gen_bool(0.1)) {
            continue;
        }
        held[lane as usize] = 1 - act;
        events.push(InputEvent {
            sequence: events.len() as u32,
            timestamp_us: t,
            lane,
            action: act,
        });
    }
    if allow_invalid && !events.is_empty() && rng.gen_bool(0.2) {
        let i = rng.gen_range(0..events.len());
        events[i].timestamp_us = events[i]
            .timestamp_us
            .saturating_sub(rng.gen_range(1..10_000));
    }
    let chart = Chart {
        key_count: 4,
        notes,
    };
    make_input(header_for(&chart), chart, events, duration)
}
