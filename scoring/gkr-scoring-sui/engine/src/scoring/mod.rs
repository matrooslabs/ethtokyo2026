//! OSUMANIA_GKR_V1 scoring proofs.
pub mod api;
pub mod encode;
pub mod layout;
pub mod prover;
pub mod relation;
pub mod session;
pub mod verifier;
pub mod witness;

use crate::field::{g1_to_bytes, G1Affine, Word, F};
use crate::logup_gkr::GkrProof;
use crate::transcript::Transcript;
use crate::zeromorph::ZmProof;

pub const DOMAIN: &[u8] = b"OSUMANIA_GKR_SUI_V1";
pub const CHART_DOMAIN: &[u8] = b"OSUMANIA_GKR_SUI_CHART_V1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Trace in calldata, SHA-256 bound, evaluated natively by the verifier.
    Calldata = 1,
    /// Trace committed by the device (KZG), opened in the batched proof.
    Committed = 2,
}

/// On-chain chart record created by `registerChart`.
#[derive(Clone, Debug)]
pub struct ChartRecord {
    pub commitment: G1Affine,
    pub m: u64,
    pub bits: u64,
    pub components: u64,
    pub max_end: u64,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub mode: Mode,
    pub session_digest: Word,
    pub n: u64,
    pub duration: u64,
    pub chart: ChartRecord,
    pub trace_commitment: Option<G1Affine>,
    pub srs_id: Word,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScoreProof {
    pub lane_bits: [u64; 4],
    pub counts: [u64; 5],
    pub adv_commitment: G1Affine,
    pub gkr: GkrProof,
    pub row_rounds: Vec<[F; 4]>,
    pub claims: Vec<F>,
    pub red_rounds: Vec<[F; 2]>,
    pub adv_eval: F,
    pub chart_eval: F,
    pub trace_eval: Option<F>,
    pub zm: ZmProof,
}

fn word_u64(x: u64) -> Word {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&x.to_be_bytes());
    w
}

pub fn absorb_statement(
    tr: &mut Transcript,
    st: &Statement,
    lane_bits: &[u64; 4],
    counts: &[u64; 5],
    adv: &G1Affine,
) {
    let mut words = vec![
        word_u64(1),
        word_u64(st.mode as u64),
        st.session_digest,
        word_u64(st.n),
        word_u64(st.duration),
        word_u64(st.chart.m),
        word_u64(st.chart.bits),
        word_u64(st.chart.components),
    ];
    words.extend(lane_bits.iter().map(|&b| word_u64(b)));
    words.extend(counts.iter().map(|&c| word_u64(c)));
    words.push(st.srs_id);
    let mut items: Vec<Vec<u8>> = words.iter().map(|w| w.to_vec()).collect();
    items.push(g1_to_bytes(&st.chart.commitment).to_vec());
    if st.mode == Mode::Committed {
        items.push(
            g1_to_bytes(
                &st.trace_commitment
                    .expect("mode B needs a trace commitment"),
            )
            .to_vec(),
        );
    }
    items.push(g1_to_bytes(adv).to_vec());
    tr.absorb_items(&items);
}

/// Score from counts exactly as the contract computes it (SPEC §4).
pub fn score(counts: &[u64; 5], components: u64) -> Option<(u64, u64, u64, u64)> {
    let hits: u64 = counts.iter().sum();
    if hits > components || components == 0 {
        return None;
    }
    let achieved =
        320 * counts[0] + 300 * counts[1] + 200 * counts[2] + 100 * counts[3] + 50 * counts[4];
    let maximum = 320 * components;
    Some((
        1_000_000 * achieved / maximum,
        achieved,
        maximum,
        components - hits,
    ))
}
