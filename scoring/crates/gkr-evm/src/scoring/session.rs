//! Session digests (SP1-compatible V1, device-KZG V2) and chart registration proofs.
use super::witness::ChartData;
use super::{ChartRecord, CHART_DOMAIN};
use crate::field::{g1_to_words, G1Affine, Word, F};
use crate::mle::mle_eval;
use crate::transcript::Transcript;
use crate::zeromorph::{self, Srs, VerifierKey, ZmProof};
use anyhow::{ensure, Result};
use mania_scoring_core::{chart_hash, Chart, SessionHeader};
use sha2::{Digest, Sha256};

pub const INPUT_POLICY_V2: &[u8] = b"OSUMANIA_INPUT_POLICY_V2_KZG";
pub const SESSION_DOMAIN_V2: &[u8] = b"OSUMANIA_HARDWARE_SESSION_V2";

pub fn input_policy_v2() -> Word {
    Sha256::digest(INPUT_POLICY_V2).into()
}

/// V2 digest: V1 header fields, then n, duration, traceRoot and the device's KZG commitment.
pub fn session_digest_v2(
    h: &SessionHeader,
    n: u32,
    duration: u64,
    trace_root: &Word,
    trace_commitment: &G1Affine,
) -> Word {
    let mut s = Sha256::new();
    s.update(SESSION_DOMAIN_V2);
    s.update(2u16.to_be_bytes());
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
    s.update(n.to_be_bytes());
    s.update(duration.to_be_bytes());
    s.update(trace_root);
    let [x, y] = g1_to_words(trace_commitment);
    s.update(x);
    s.update(y);
    s.finalize().into()
}

/// SP1 canonical chart bytes (`OSUMANIA_CHART_V1` ‖ …), hashed with SHA-256 to chartHash.
pub fn chart_bytes(chart: &Chart) -> Vec<u8> {
    let mut out = b"OSUMANIA_CHART_V1".to_vec();
    out.extend(1u16.to_be_bytes());
    out.push(chart.key_count);
    out.extend((chart.notes.len() as u32).to_be_bytes());
    for n in &chart.notes {
        out.push(n.lane);
        out.extend(n.start_us.to_be_bytes());
        out.extend(n.end_us.to_be_bytes());
    }
    out
}

pub struct ChartRegistration {
    pub record: ChartRecord,
    pub chart_hash: Word,
    pub proof: ZmProof,
    pub point: Vec<F>,
    pub value: F,
}

fn chart_point(
    tr: &mut Transcript,
    chart_hash: &Word,
    commitment: &G1Affine,
    vars: usize,
) -> Vec<F> {
    let [x, y] = g1_to_words(commitment);
    tr.absorb_words(&[*chart_hash, x, y]);
    tr.squeeze_n(vars)
}

/// Organizer: commit to the chart and prove the commitment matches the canonical bytes.
pub fn register_chart(srs: &Srs, chart: &Chart) -> Result<ChartRegistration> {
    let data = ChartData::from_chart(chart)?;
    let hash = chart_hash(chart);
    debug_assert_eq!(hash, <[u8; 32]>::from(Sha256::digest(chart_bytes(chart))));
    let rm = data.rowmajor();
    let commitment = srs.commit(&rm);
    let vars = 3 + data.bits;
    let mut tr = Transcript::new(CHART_DOMAIN);
    let point = chart_point(&mut tr, &hash, &commitment, vars);
    let value = mle_eval(&rm, &point);
    tr.absorb(&[value]);
    let proof = zeromorph::open(srs, &rm, &point, &mut tr);
    Ok(ChartRegistration {
        record: ChartRecord {
            commitment,
            m: data.m as u64,
            bits: data.bits as u64,
            components: data.components,
            max_end: data.max_end,
        },
        chart_hash: hash,
        proof,
        point,
        value,
    })
}

/// What `registerChart` checks on-chain: validity, hash, and commitment consistency.
pub fn verify_chart_registration(
    vk: &VerifierKey,
    chart: &Chart,
    commitment: &G1Affine,
    proof: &ZmProof,
) -> Result<ChartRecord> {
    let data = ChartData::from_chart(chart)?;
    let hash = chart_hash(chart);
    let rm = data.rowmajor();
    let vars = 3 + data.bits;
    ensure!(vars <= vk.smax, "chart exceeds SRS");
    let mut tr = Transcript::new(CHART_DOMAIN);
    let point = chart_point(&mut tr, &hash, commitment, vars);
    let value = mle_eval(&rm, &point);
    tr.absorb(&[value]);
    zeromorph::verify(vk, *commitment, &point, value, proof, &mut tr)?;
    Ok(ChartRecord {
        commitment: *commitment,
        m: data.m as u64,
        bits: data.bits as u64,
        components: data.components,
        max_end: data.max_end,
    })
}
