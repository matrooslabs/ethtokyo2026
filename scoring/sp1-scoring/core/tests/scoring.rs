use mania_scoring_core::*;

fn demo() -> PlayInput {
    serde_json::from_str(include_str!("../../fixtures/demo.json")).unwrap()
}

// Resealing is allowed ONLY in synthetic tests; a real device signature would no longer match.
fn seal(p: &mut PlayInput) {
    p.header.chart_hash = chart_hash(&p.chart);
    p.footer.event_count = p.events.len() as u32;
    p.footer.trace_root = trace_root(&p.header.session_id, &p.events);
}

fn perfect_play(note_count: usize, shape: usize) -> PlayInput {
    let mut p = demo();
    p.chart.notes = (0..note_count)
        .map(|i| {
            let start_us = 1_000_000 + i as u64 * 150_000;
            let hold = shape == 1 || (shape == 2 && i % 3 == 0);
            Note {
                lane: (i % 4) as u8,
                start_us,
                end_us: start_us + if hold { 300_000 } else { 0 },
            }
        })
        .collect();
    p.events = p
        .chart
        .notes
        .iter()
        .flat_map(|n| {
            [
                InputEvent {
                    sequence: 0,
                    timestamp_us: n.start_us,
                    lane: n.lane,
                    action: 0,
                },
                InputEvent {
                    sequence: 0,
                    timestamp_us: n.end_us + u64::from(n.start_us == n.end_us),
                    lane: n.lane,
                    action: 1,
                },
            ]
        })
        .collect();
    p.events.sort_by_key(|e| (e.timestamp_us, e.lane, e.action));
    for (i, e) in p.events.iter_mut().enumerate() {
        e.sequence = i as u32;
    }
    p.footer.duration_us = p.chart.notes.iter().map(|n| n.end_us).max().unwrap() + WINDOWS_US[4];
    seal(&mut p);
    p
}

#[test]
fn perfect_taps_holds_and_mixed_charts_reach_exactly_one_million() {
    for count in [1, 4, 32, 500, 1500, 3000, MAX_NOTES] {
        for shape in 0..3 {
            let p = perfect_play(count, shape);
            let result = evaluate(&p).unwrap();
            let components: u32 = p
                .chart
                .notes
                .iter()
                .map(|n| if n.start_us < n.end_us { 2 } else { 1 })
                .sum();
            assert_eq!(result.score, 1_000_000, "notes={count}, shape={shape}");
            assert_eq!(result.achieved_points, result.maximum_points);
            assert_eq!(result.judgements, [components, 0, 0, 0, 0, 0]);
        }
    }
}

#[test]
fn extra_edges_cannot_exceed_one_million_and_a_great_lowers_score() {
    let mut p = perfect_play(4, 2);
    p.events.extend([
        InputEvent {
            sequence: 0,
            timestamp_us: p.footer.duration_us - 1,
            lane: 3,
            action: 0,
        },
        InputEvent {
            sequence: 0,
            timestamp_us: p.footer.duration_us,
            lane: 3,
            action: 1,
        },
    ]);
    for (i, e) in p.events.iter_mut().enumerate() {
        e.sequence = i as u32;
    }
    seal(&mut p);
    assert_eq!(evaluate(&p).unwrap().score, 1_000_000);
    // The first head is a hold, leaving its release and every other edge unchanged.
    p.events[0].timestamp_us += WINDOWS_US[0] + 1;
    seal(&mut p);
    assert!(evaluate(&p).unwrap().score < 1_000_000);
}

#[test]
fn perfect_fixture_is_one_million() {
    let p: PlayInput = serde_json::from_str(include_str!("../../fixtures/perfect.json")).unwrap();
    let output = evaluate(&p).unwrap();
    assert_eq!(output.score, 1_000_000);
    assert_eq!(output.judgements, [5, 0, 0, 0, 0, 0]);
}

fn single(hold: bool, edges: &[(u64, u8)]) -> PlayInput {
    let mut p = demo();
    p.chart.notes = vec![Note {
        lane: 0,
        start_us: 1_000_000,
        end_us: if hold { 2_000_000 } else { 1_000_000 },
    }];
    p.events = edges
        .iter()
        .enumerate()
        .map(|(i, &(timestamp_us, action))| InputEvent {
            sequence: i as u32,
            timestamp_us,
            lane: 0,
            action,
        })
        .collect();
    seal(&mut p);
    p
}

#[test]
fn cross_language_golden_vector() {
    let p = demo();
    let actual = evaluate(&p).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/demo.expected.json")).unwrap();
    let result: PublicValues = serde_json::from_value(expected["result"].clone()).unwrap();
    assert_eq!(actual, result);
    assert_eq!(actual.score, 987_500);
    assert_eq!(actual.judgements, [4, 1, 0, 0, 0, 0]);
    let hex: String = actual
        .abi_encode()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(format!("0x{hex}"), expected["publicValues"]);
    assert_eq!(actual.abi_encode().len(), 512);
}

#[test]
fn python_hash_chain_vectors_cover_empty_full_and_partial_chunks() {
    let vectors: std::collections::BTreeMap<String, Hash> =
        serde_json::from_str(include_str!("../../fixtures/trace-vectors.json")).unwrap();
    let events: Vec<InputEvent> = (0..65)
        .map(|i| InputEvent {
            sequence: i,
            timestamp_us: i as u64 * 1000,
            lane: 0,
            action: (i % 2) as u8,
        })
        .collect();
    for (length, expected) in vectors {
        let n: usize = length.parse().unwrap();
        assert_eq!(trace_root(&[2; 32], &events[..n]), expected, "length {n}");
    }
}

#[test]
fn inclusive_windows_and_one_microsecond_outside_on_both_sides() {
    for (j, window) in WINDOWS_US.into_iter().enumerate() {
        for sign in [-1i64, 1] {
            for extra in [0, 1] {
                let time = (1_000_000i64 + sign * (window + extra) as i64) as u64;
                let result = evaluate(&single(false, &[(time, 0)])).unwrap();
                let expected = if extra == 0 { j } else { j + 1 };
                assert_eq!(
                    result.judgements[expected], 1,
                    "window={window}, sign={sign}, extra={extra}"
                );
                assert_eq!(result.score, (WEIGHTS[expected] * 1_000_000 / 320) as u32);
            }
        }
    }
}

#[test]
fn hold_head_tail_and_no_recovery_after_early_release() {
    assert_eq!(
        evaluate(&single(true, &[(1_000_000, 0), (2_000_000, 1)]))
            .unwrap()
            .score,
        1_000_000
    );
    for edges in [
        vec![(1_000_000, 0)],
        vec![(1_000_000, 0), (1_500_000, 1)],
        vec![
            (1_000_000, 0),
            (1_500_000, 1),
            (1_900_000, 0),
            (2_000_000, 1),
        ],
    ] {
        assert_eq!(
            evaluate(&single(true, &edges)).unwrap().judgements,
            [1, 0, 0, 0, 0, 1]
        );
    }
    assert_eq!(
        evaluate(&single(true, &[(2_000_000, 0), (2_000_001, 1)]))
            .unwrap()
            .judgements[5],
        2
    );
}

#[test]
fn silence_scores_all_misses_and_denominator_includes_unplayed_notes() {
    let mut p = demo();
    p.events.clear();
    seal(&mut p);
    let result = evaluate(&p).unwrap();
    assert_eq!(result.score, 0);
    assert_eq!(result.judgements[5], 5);
    assert_eq!(result.maximum_points, 1600);
}

#[test]
fn notelock_consumes_earliest_pending_note_only() {
    let mut p = single(false, &[(1_080_000, 0)]);
    p.chart.notes.push(Note {
        lane: 0,
        start_us: 1_080_000,
        end_us: 1_080_000,
    });
    seal(&mut p);
    assert_eq!(evaluate(&p).unwrap().judgements, [0, 0, 1, 0, 0, 1]);
}

#[test]
fn stale_head_expires_before_matching_next_note() {
    let mut p = single(false, &[(1_500_000, 0)]);
    p.chart.notes.push(Note {
        lane: 0,
        start_us: 1_500_000,
        end_us: 1_500_000,
    });
    seal(&mut p);
    assert_eq!(evaluate(&p).unwrap().judgements, [1, 0, 0, 0, 0, 1]);
}

#[test]
fn malformed_streams_rejected_even_with_matching_commitment() {
    let bad = [
        vec![(1_000_000, 1)],
        vec![(1_000_000, 0), (1_000_001, 0)],
        vec![(1_000_000, 0), (999_999, 1)],
        vec![(1_000_000, 2)],
        vec![(3_000_000, 0)],
    ];
    for edges in bad {
        assert!(evaluate(&single(false, &edges)).is_err());
    }
    for which in 0..3 {
        let mut p = demo();
        match which {
            0 => p.events[0].sequence = 1,
            1 => p.events[0].lane = 4,
            _ => p.events[0].action = 255,
        }
        seal(&mut p);
        assert!(evaluate(&p).is_err());
    }
}

#[test]
fn tampering_deletion_insertion_reordering_and_truncation_rejected() {
    for which in 0..7 {
        let mut p = demo();
        match which {
            0 => p.events[0].timestamp_us += 1,
            1 => {
                p.events.pop();
            }
            2 => p.events.push(p.events[0].clone()),
            3 => p.events.swap(0, 1),
            4 => p.chart.notes[0].start_us -= 1,
            5 => p.footer.duration_us = 1_000_000,
            _ => p.footer.event_count += 1,
        }
        assert!(evaluate(&p).is_err(), "mutation {which}");
    }
}

#[test]
fn invalid_chart_and_ruleset_rejected() {
    for which in 0..8 {
        let mut p = demo();
        match which {
            0 => p.chart.key_count = 7,
            1 => p.chart.notes.clear(),
            2 => p.chart.notes[0].lane = 4,
            3 => p.chart.notes.swap(0, 1),
            4 => p.chart.notes[0].end_us = u64::MAX,
            5 => p.header.ruleset_id = [0; 32],
            6 => p.header.input_policy_hash = [0; 32],
            _ => {
                p.chart.notes[2].lane = 1;
            }
        }
        seal(&mut p);
        assert!(evaluate(&p).is_err(), "mutation {which}");
    }
}

#[test]
fn entire_session_context_and_footer_are_digest_bound() {
    let p = demo();
    let digest = session_digest(&p.header, &p.footer);
    for which in 0..14 {
        let mut p = p.clone();
        match which {
            0 => p.header.chain_id += 1,
            1 => p.header.verifier[0] ^= 1,
            2 => p.header.match_id[0] ^= 1,
            3 => p.header.session_id[0] ^= 1,
            4 => p.header.challenge[0] ^= 1,
            5 => p.header.player[0] ^= 1,
            6 => p.header.device[0] ^= 1,
            7 => p.header.chart_hash[0] ^= 1,
            8 => p.header.ruleset_id[0] ^= 1,
            9 => p.header.bitstream_hash[0] ^= 1,
            10 => p.header.input_policy_hash[0] ^= 1,
            11 => p.footer.event_count += 1,
            12 => p.footer.duration_us += 1,
            _ => p.footer.trace_root[0] ^= 1,
        }
        assert_ne!(session_digest(&p.header, &p.footer), digest);
    }
}

#[test]
fn exact_duration_boundary_is_complete_and_limits_are_enforced() {
    let mut p = single(false, &[]);
    p.footer.duration_us = 1_136_500;
    assert_eq!(evaluate(&p).unwrap().judgements[5], 1);
    p.footer.duration_us -= 1;
    assert!(evaluate(&p).is_err());
    p.footer.duration_us = MAX_DURATION_US + 1;
    assert!(evaluate(&p).is_err());
    p = single(false, &[]);
    p.events = vec![
        InputEvent {
            sequence: 0,
            timestamp_us: 0,
            lane: 0,
            action: 0
        };
        MAX_EVENTS + 1
    ];
    seal(&mut p);
    assert!(evaluate(&p).is_err());
}
