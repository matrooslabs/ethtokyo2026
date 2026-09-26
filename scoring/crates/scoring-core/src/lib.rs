//! Deterministic tournament scoring. No floating point, host clock, RPC, or signature oracle.
//! The proof consumer MUST authenticate `session_digest` against its device registry.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];
pub const RULESET_NAME: &[u8] = b"OSUMANIA_ONCHAIN_RULESET_V1";
pub const INPUT_POLICY_NAME: &[u8] = b"OSUMANIA_INPUT_POLICY_V1";
pub const SESSION_DOMAIN: &[u8] = b"OSUMANIA_HARDWARE_SESSION_V1";
pub const WINDOWS_US: [u64; 5] = [19_500, 49_500, 82_500, 112_500, 136_500];
pub const WEIGHTS: [u64; 6] = [320, 300, 200, 100, 50, 0];
pub const MAX_NOTES: usize = 10_000;
pub const MAX_EVENTS: usize = 50_000;
pub const MAX_DURATION_US: u64 = 1_800_000_000;
pub const CHUNK_EVENTS: usize = 32;
const LAST_WINDOW: u64 = WINDOWS_US[4];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub lane: u8,
    pub start_us: u64,
    pub end_us: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chart {
    pub key_count: u8,
    pub notes: Vec<Note>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputEvent {
    pub sequence: u32,
    pub timestamp_us: u64,
    pub lane: u8,
    /// 0 = DOWN, 1 = UP. Numeric representation is also used on the wire.
    pub action: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionHeader {
    pub chain_id: u64,
    pub verifier: [u8; 20],
    pub match_id: Hash,
    pub session_id: Hash,
    pub challenge: Hash,
    pub player: [u8; 20],
    pub device: [u8; 20],
    pub chart_hash: Hash,
    pub ruleset_id: Hash,
    pub bitstream_hash: Hash,
    pub input_policy_hash: Hash,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionFooter {
    pub event_count: u32,
    pub duration_us: u64,
    pub trace_root: Hash,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayInput {
    pub header: SessionHeader,
    pub footer: SessionFooter,
    pub chart: Chart,
    pub events: Vec<InputEvent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicValues {
    pub session_id: Hash,
    pub chart_hash: Hash,
    pub ruleset_id: Hash,
    pub trace_root: Hash,
    pub session_digest: Hash,
    pub event_count: u32,
    pub duration_us: u64,
    pub score: u32,
    pub achieved_points: u64,
    pub maximum_points: u64,
    /// PERFECT, GREAT, GOOD, OK, MEH, MISS; tap=one component, hold=two.
    pub judgements: [u32; 6],
}

impl PublicValues {
    /// abi.encode(PublicValues): five bytes32, five unsigned integers, uint32[6].
    /// All fields are static; there is no leading tuple offset.
    pub fn abi_encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 * 32);
        for hash in [
            self.session_id,
            self.chart_hash,
            self.ruleset_id,
            self.trace_root,
            self.session_digest,
        ] {
            out.extend_from_slice(&hash);
        }
        for value in [
            self.event_count as u64,
            self.duration_us,
            self.score as u64,
            self.achieved_points,
            self.maximum_points,
        ]
        .into_iter()
        .chain(self.judgements.map(u64::from))
        {
            out.extend_from_slice(&[0; 24]);
            out.extend_from_slice(&value.to_be_bytes());
        }
        out
    }
}

pub fn sha256(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}
pub fn ruleset_id() -> Hash {
    sha256(RULESET_NAME)
}
pub fn input_policy_hash() -> Hash {
    sha256(INPUT_POLICY_NAME)
}

/// Fixed-width, big-endian encoding; never hash JSON or serde/bincode bytes.
pub fn chart_hash(chart: &Chart) -> Hash {
    let mut h = Sha256::new();
    h.update(b"OSUMANIA_CHART_V1");
    h.update(1u16.to_be_bytes());
    h.update([chart.key_count]);
    h.update((chart.notes.len() as u32).to_be_bytes());
    for n in &chart.notes {
        h.update([n.lane]);
        h.update(n.start_us.to_be_bytes());
        h.update(n.end_us.to_be_bytes());
    }
    h.finalize().into()
}

pub fn trace_root(session_id: &Hash, events: &[InputEvent]) -> Hash {
    let mut seed = Sha256::new();
    seed.update(b"OSUMANIA_TRACE_V1");
    seed.update(session_id);
    let mut root: Hash = seed.finalize().into();
    for (index, chunk) in events.chunks(CHUNK_EVENTS).enumerate() {
        let mut h = Sha256::new();
        h.update(root);
        h.update((index as u32).to_be_bytes());
        h.update((chunk.len() as u16).to_be_bytes());
        for e in chunk {
            h.update(e.sequence.to_be_bytes());
            h.update(e.timestamp_us.to_be_bytes());
            h.update([e.lane, e.action]);
        }
        root = h.finalize().into();
    }
    root
}

pub fn session_digest(h: &SessionHeader, f: &SessionFooter) -> Hash {
    let mut s = Sha256::new();
    s.update(SESSION_DOMAIN);
    s.update(1u16.to_be_bytes());
    s.update(h.chain_id.to_be_bytes());
    s.update(h.verifier);
    s.update(h.match_id);
    s.update(h.session_id);
    s.update(h.challenge);
    s.update(h.player);
    s.update(h.device);
    s.update(h.chart_hash);
    s.update(h.ruleset_id);
    s.update(h.bitstream_hash);
    s.update(h.input_policy_hash);
    s.update(f.event_count.to_be_bytes());
    s.update(f.duration_us.to_be_bytes());
    s.update(f.trace_root);
    s.finalize().into()
}

/// Validates chart topology independently of its commitment.
pub fn validate_chart(chart: &Chart) -> Result<(), &'static str> {
    if chart.key_count != 4 || chart.notes.is_empty() || chart.notes.len() > MAX_NOTES {
        return Err("chart must contain 1..10000 notes in exactly four lanes");
    }
    let mut last_order = None;
    let mut last_end = [None; 4];
    for n in &chart.notes {
        if n.lane >= 4 || n.start_us > n.end_us || n.end_us > MAX_DURATION_US - LAST_WINDOW {
            return Err("invalid note lane or time");
        }
        let order = (n.start_us, n.lane);
        if last_order.is_some_and(|p| p >= order) {
            return Err("chart must be strictly sorted by (start_us, lane)");
        }
        if last_end[n.lane as usize].is_some_and(|end| n.start_us <= end) {
            return Err("same-lane notes must not overlap or share an endpoint");
        }
        last_order = Some(order);
        last_end[n.lane as usize] = Some(n.end_us);
    }
    Ok(())
}

fn judgement(delta: u64) -> usize {
    WINDOWS_US.iter().position(|&w| delta <= w).unwrap_or(5)
}

#[derive(Default)]
struct Lane<'a> {
    notes: Vec<&'a Note>,
    cursor: usize,
    held: bool,
    active_tail: Option<u64>,
}

impl Lane<'_> {
    fn expire(&mut self, now: u64, counts: &mut [u32; 6]) {
        if self
            .active_tail
            .is_some_and(|tail| now > tail + LAST_WINDOW)
        {
            counts[5] += 1;
            self.active_tail = None;
        }
        while let Some(n) = self.notes.get(self.cursor) {
            if now <= n.start_us + LAST_WINDOW {
                break;
            }
            counts[5] += if n.end_us > n.start_us { 2 } else { 1 };
            self.cursor += 1;
        }
    }
}

/// O(notes + events). Host and zkVM call this exact function.
pub fn evaluate(input: &PlayInput) -> Result<PublicValues, &'static str> {
    evaluate_with_policy(input, input_policy_hash())
}

/// Score the original header under an explicitly selected protocol policy.
/// The caller remains responsible for the protocol-specific signed digest.
pub fn evaluate_with_policy(input: &PlayInput, policy: Hash) -> Result<PublicValues, &'static str> {
    validate_chart(&input.chart)?;
    let h = &input.header;
    let f = &input.footer;
    if h.ruleset_id != ruleset_id() || h.input_policy_hash != policy {
        return Err("unsupported ruleset or input policy");
    }
    if h.chart_hash != chart_hash(&input.chart) {
        return Err("chart hash mismatch");
    }
    if input.events.len() > MAX_EVENTS || input.events.len() != f.event_count as usize {
        return Err("event count mismatch or event limit exceeded");
    }
    let end = input.chart.notes.iter().map(|n| n.end_us).max().unwrap();
    if f.duration_us < end + LAST_WINDOW || f.duration_us > MAX_DURATION_US {
        return Err("recording must cover the entire chart and final hit window");
    }
    if f.trace_root != trace_root(&h.session_id, &input.events) {
        return Err("trace root mismatch");
    }

    let mut lanes: [Lane<'_>; 4] = std::array::from_fn(|_| Lane::default());
    let mut components = 0u64;
    for n in &input.chart.notes {
        lanes[n.lane as usize].notes.push(n);
        components += if n.end_us > n.start_us { 2 } else { 1 };
    }
    let mut counts = [0u32; 6];
    let mut previous_time = 0;
    for (seq, e) in input.events.iter().enumerate() {
        if e.sequence as usize != seq
            || e.timestamp_us < previous_time
            || e.timestamp_us > f.duration_us
            || e.lane >= 4
            || e.action > 1
        {
            return Err("invalid event sequence, time, lane, or action");
        }
        previous_time = e.timestamp_us;
        let lane = &mut lanes[e.lane as usize];
        if lane.held == (e.action == 0) {
            return Err("duplicate DOWN or unmatched UP");
        }
        lane.expire(e.timestamp_us, &mut counts);
        lane.held = e.action == 0;
        if e.action == 1 {
            if let Some(tail) = lane.active_tail.take() {
                counts[judgement(e.timestamp_us.abs_diff(tail))] += 1;
            }
        } else if lane.active_tail.is_none() {
            if let Some(n) = lane.notes.get(lane.cursor) {
                let j = judgement(e.timestamp_us.abs_diff(n.start_us));
                if j != 5 {
                    counts[j] += 1;
                    lane.cursor += 1;
                    if n.end_us > n.start_us {
                        lane.active_tail = Some(n.end_us);
                    }
                }
            }
        }
    }
    // At the exact inclusive final boundary, an absent event is still a miss.
    for lane in &mut lanes {
        lane.expire(f.duration_us + 1, &mut counts);
    }
    if counts.iter().map(|&n| n as u64).sum::<u64>() != components {
        return Err("internal scoring component mismatch");
    }
    let achieved_points = counts
        .iter()
        .zip(WEIGHTS)
        .map(|(&n, w)| n as u64 * w)
        .sum::<u64>();
    let maximum_points = components * 320;
    Ok(PublicValues {
        session_id: h.session_id,
        chart_hash: h.chart_hash,
        ruleset_id: h.ruleset_id,
        trace_root: f.trace_root,
        session_digest: session_digest(h, f),
        event_count: f.event_count,
        duration_us: f.duration_us,
        score: (1_000_000 * achieved_points / maximum_points) as u32,
        achieved_points,
        maximum_points,
        judgements: counts,
    })
}
