//! Canonical chart/replay parsing and hardware seal authentication.
use alloy::primitives::{Address, Signature, B256};
use anyhow::{ensure, Context, Result};
use mania_scoring_core::{sha256, trace_root, Chart, InputEvent, Note, PlayInput, SessionHeader};

pub struct ParsedChart {
    pub chart: Chart,
    pub web_hash: String,
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
        max_end,
        web_hash: hex::encode(sha256(bytes)),
        chart: Chart {
            key_count: 4,
            notes,
        },
    })
}

/// Board wire bytes, never ABI encoding or a replacement header.
pub fn packed_header(h: &SessionHeader) -> Vec<u8> {
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
    b
}

#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub result: String,
    pub trace: String,
    pub web_beatmap_hash: String,
}
impl Capture {
    pub fn decode(
        &self,
        header: &SessionHeader,
        chart: &ParsedChart,
        capacity: u32,
    ) -> Result<(PlayInput, [[u8; 32]; 2], Vec<u8>, B256)> {
        let decode = |s: &str| -> Result<Vec<u8>> {
            hex::decode(s.strip_prefix("0x").context("hex prefix required")?).map_err(Into::into)
        };
        let b: Vec<u8> = decode(&self.result)?;
        let trace: Vec<u8> = decode(&self.trace)?;
        ensure!(
            b.len() == 465 && trace.len() <= 700000,
            "invalid capture length"
        );
        ensure!(
            b[..292] == packed_header(header),
            "original header mismatch"
        );
        ensure!(
            header.input_policy_hash == mania_gkr::scoring::session::input_policy_v2(),
            "not Mode B"
        );
        let n = u32::from_be_bytes(b[292..296].try_into()?);
        let duration = u64::from_be_bytes(b[296..304].try_into()?);
        ensure!(
            n <= capacity && n <= 50000 && trace.len() == n as usize * 14,
            "event count/capacity mismatch"
        );
        ensure!(
            duration >= chart.max_end + 136500 && duration <= 1_800_000_000,
            "invalid duration"
        );
        let events = trace
            .chunks_exact(14)
            .map(|e| InputEvent {
                sequence: u32::from_be_bytes(e[..4].try_into().unwrap()),
                timestamp_us: u64::from_be_bytes(e[4..12].try_into().unwrap()),
                lane: e[12],
                action: e[13],
            })
            .collect();
        let input = PlayInput {
            header: header.clone(),
            footer: mania_scoring_core::SessionFooter {
                event_count: n,
                duration_us: duration,
                trace_root: b[304..336].try_into()?,
            },
            chart: chart.chart.clone(),
            events,
        };
        mania_scoring_core::evaluate_with_policy(
            &input,
            mania_gkr::scoring::session::input_policy_v2(),
        )
        .map_err(anyhow::Error::msg)?;
        ensure!(
            trace_root(&header.session_id, &input.events) == input.footer.trace_root,
            "trace root mismatch"
        );
        let commitment = [b[336..368].try_into()?, b[368..400].try_into()?];
        let tc =
            mania_gkr::field::g1_from_words(&commitment).context("invalid commitment point")?;
        let digest = B256::from(mania_gkr::scoring::session::session_digest_v2(
            header,
            n,
            duration,
            &input.footer.trace_root,
            &tc,
        ));
        let signature = b[400..].to_vec();
        ensure!([27, 28].contains(&signature[64]), "invalid recovery byte");
        let sig: Signature = format!("0x{}", hex::encode(&signature)).parse()?;
        ensure!(sig.normalize_s().is_none(), "noncanonical high-s signature");
        ensure!(
            sig.recover_address_from_prehash(&digest)? == Address::from(header.device),
            "signature mismatch"
        );
        Ok((input, commitment, signature, digest))
    }
}
