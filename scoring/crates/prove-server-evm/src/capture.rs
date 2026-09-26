//! Canonical chart/replay parsing and hardware seal authentication.
use alloy::primitives::{Address, Signature, B256};
use anyhow::{bail, ensure, Context, Result};
use mania_scoring_core::{
    session_digest, sha256, trace_root, Chart, InputEvent, Note, PlayInput, SessionHeader,
};
use serde_json::Value;

pub struct ParsedChart {
    pub chart: Chart,
    pub web_hash: String,
    pub first_note_ms: u64,
    pub max_end: u64,
}

pub fn parse_osu(bytes: &[u8]) -> Result<ParsedChart> {
    let text = std::str::from_utf8(bytes)?.trim_start_matches('\u{feff}');
    let mut section = "";
    let mut mode = None;
    let mut keys = None;
    let mut notes = Vec::new();
    for line in text
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("//"))
    {
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        if section == "HitObjects" {
            let p: Vec<_> = line.split(',').collect();
            ensure!(p.len() >= 5, "invalid hit object");
            let x: u64 = p[0].parse()?;
            let ms: u64 = p[2].parse()?;
            let kind: u64 = p[3].parse()?;
            ensure!(
                x <= 512 && (kind & 1 != 0 || kind & 128 != 0),
                "unsupported hit object"
            );
            let end: u64 = if kind & 128 != 0 {
                p.get(5)
                    .context("missing hold end")?
                    .split(':')
                    .next()
                    .unwrap()
                    .parse()?
            } else {
                ms
            };
            ensure!(end >= ms && end <= 1_800_000, "invalid hold/duration");
            notes.push(Note {
                lane: (x * 4 / 512).min(3) as u8,
                start_us: ms * 1000,
                end_us: end * 1000,
            });
        } else if let Some((k, v)) = line.split_once(':') {
            match (section, k.trim()) {
                ("General", "Mode") => mode = Some(v.trim()),
                ("Difficulty", "CircleSize") => keys = Some(v.trim()),
                _ => {}
            }
        }
    }
    ensure!(
        mode == Some("3") && keys.and_then(|s| s.parse::<f64>().ok()) == Some(4.0),
        "only 4-key mania charts supported"
    );
    ensure!(
        !notes.is_empty() && notes.len() <= 10000,
        "chart note count out of range"
    );
    notes.sort_by_key(|n| (n.start_us, n.lane, n.end_us));
    let mut ends = [None; 4];
    for n in &notes {
        ensure!(
            ends[n.lane as usize].is_none_or(|end| n.start_us > end),
            "overlapping or duplicate notes"
        );
        ends[n.lane as usize] = Some(n.end_us);
    }
    let max_end = notes.iter().map(|n| n.end_us).max().unwrap();
    ensure!(
        max_end + 136500 <= 1_800_000_000,
        "chart exceeds maximum duration"
    );
    Ok(ParsedChart {
        first_note_ms: notes[0].start_us / 1000,
        max_end,
        web_hash: hex::encode(sha256(bytes)),
        chart: Chart {
            key_count: 4,
            notes,
        },
    })
}

pub fn replay_events(body: &Value, chart: &ParsedChart) -> Result<Vec<InputEvent>> {
    let replay = &body["replay"];
    ensure!(replay["version"] == 2, "unsupported replay");
    let inputs = replay["inputs"].as_array().context("unsupported replay")?;
    ensure!(inputs.len() <= 50000, "too many events");
    let mods = &replay["mods"];
    ensure!(
        mods["bits"] == 0
            && mods["rate"].as_f64() == Some(1.0)
            && [
                "hpOverride",
                "odOverride",
                "accuracyChallenge",
                "cover",
                "percy"
            ]
            .iter()
            .all(|k| mods[k].is_null()),
        "scoring mods unsupported"
    );
    let delay = 1000u64.saturating_sub(chart.first_note_ms);
    ensure!(
        body["timing"]["chartDelayMs"].as_u64() == Some(delay),
        "chart timing mismatch"
    );
    let mut last = 0;
    let mut keys = [false; 4];
    inputs
        .iter()
        .enumerate()
        .map(|(sequence, event)| {
            ensure!(
                event.as_array().is_some_and(|a| a.len() == 3),
                "invalid replay event"
            );
            let lane = event[0].as_u64().context("invalid lane")?;
            let time = event[1].as_f64().context("invalid timestamp")?;
            let down = event[2].as_bool().context("invalid key state")?;
            // Match JavaScript Math.round, including negative half values.
            let us = ((time - delay as f64) * 1000.0 + 0.5).floor();
            ensure!(
                lane < 4
                    && us.is_finite()
                    && (0.0..=1_800_000_000.0).contains(&us)
                    && us >= last as f64,
                "invalid replay timestamp/lane"
            );
            ensure!(keys[lane as usize] != down, "invalid replay key transition");
            keys[lane as usize] = down;
            last = us as u64;
            Ok(InputEvent {
                sequence: sequence as u32,
                timestamp_us: last,
                lane: lane as u8,
                action: if down { 0 } else { 1 },
            })
        })
        .collect()
}

pub fn validate_seal(
    header: &SessionHeader,
    input: &PlayInput,
    signature: &str,
) -> Result<Vec<u8>> {
    ensure!(
        serde_json::to_value(&input.header)? == serde_json::to_value(header)?,
        "hardware header differs from paid session"
    );
    ensure!(
        input.footer.event_count as usize == input.events.len(),
        "hardware event count mismatch"
    );
    ensure!(
        trace_root(&header.session_id, &input.events) == input.footer.trace_root,
        "hardware trace root mismatch"
    );
    let sig: Signature = signature.parse().context("invalid hardware signature")?;
    let digest = B256::from(session_digest(header, &input.footer));
    ensure!(
        sig.recover_address_from_prehash(&digest)? == Address::from(header.device),
        "hardware signature mismatch"
    );
    // Serialize Ethereum's canonical r || s || v (v=27/28).
    let bytes = sig.as_bytes().to_vec();
    if bytes.len() != 65 {
        bail!("invalid signature length");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::signers::{local::PrivateKeySigner, SignerSync};
    use serde_json::json;
    const OSU:&[u8]=b"osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,500,1,0,0:0:0:0:\n192,192,1500,128,0,2000:0:0:0:0:\n";
    fn replay() -> Value {
        json!({"replay":{"version":2,"mods":{"bits":0,"rate":1},"inputs":[[0,1000,true],[0,1001,false]]},"timing":{"chartDelayMs":500}})
    }
    #[test]
    fn chart_and_replay_preserve_canonical_timing() {
        let chart = parse_osu(OSU).unwrap();
        let events = replay_events(&replay(), &chart).unwrap();
        assert_eq!(chart.first_note_ms, 500);
        assert_eq!(events[0].timestamp_us, 500000);
        assert_eq!(events[1].action, 1);
        let mut bom = vec![239, 187, 191];
        bom.extend(OSU);
        assert_ne!(parse_osu(&bom).unwrap().web_hash, chart.web_hash);
        assert_eq!(chart.chart.notes[1].end_us, 2000000);
    }
    #[test]
    fn replay_rejects_mods_timing_and_duplicate_keys() {
        let chart = parse_osu(OSU).unwrap();
        let mut p = replay();
        p["timing"]["chartDelayMs"] = json!(0);
        assert!(replay_events(&p, &chart).is_err());
        let mut p = replay();
        p["replay"]["mods"]["bits"] = json!(1);
        assert!(replay_events(&p, &chart).is_err());
        let mut p = replay();
        p["replay"]["inputs"][1][2] = json!(true);
        assert!(replay_events(&p, &chart).is_err());
        let mut p = replay();
        p["replay"]["inputs"] = json!([]);
        assert!(replay_events(&p, &chart).unwrap().is_empty());
    }
    #[test]
    fn signed_seal_binds_header_event_count_and_trace() {
        let mut input: PlayInput =
            serde_json::from_str(include_str!("../../../fixtures/demo.json")).unwrap();
        let signer: PrivateKeySigner = format!("{:064x}", 77).parse().unwrap();
        input.header.device = signer.address().into_array();
        let signature = signer
            .sign_hash_sync(&B256::from(session_digest(&input.header, &input.footer)))
            .unwrap()
            .to_string();
        assert_eq!(
            validate_seal(&input.header, &input, &signature)
                .unwrap()
                .len(),
            65
        );
        let mut header = input.header.clone();
        header.challenge[0] ^= 1;
        assert!(validate_seal(&header, &input, &signature).is_err());
        let mut changed = input.clone();
        changed.footer.event_count += 1;
        assert!(validate_seal(&input.header, &changed, &signature).is_err());
        let mut changed = input.clone();
        changed.events[0].timestamp_us += 1;
        assert!(validate_seal(&input.header, &changed, &signature).is_err());
        let mut changed = input.clone();
        changed.footer.duration_us += 1;
        assert!(validate_seal(&input.header, &changed, &signature).is_err());
    }
}
