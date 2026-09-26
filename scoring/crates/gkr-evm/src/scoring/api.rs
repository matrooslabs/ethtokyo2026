//! Convenience entry points: statement construction, prove, verify.
use super::prover::{self, Timings};
use super::session::{input_policy_v2, session_digest_v2};
use super::verifier::{self, VerifiedScore};
use super::witness::{self, trace_rowmajor, Witness};
use super::{ChartRecord, Mode, ScoreProof, Statement};
use crate::field::G1Affine;
use crate::zeromorph::{Srs, VerifierKey};
use anyhow::Result;
use mania_scoring_core::{session_digest, InputEvent, PlayInput, SessionHeader};

/// Device-side KZG commitment of the trace (mode B, SPEC §7.3).
pub fn device_trace_commitment(srs: &Srs, events: &[InputEvent]) -> G1Affine {
    srs.commit(&trace_rowmajor(events))
}

/// The statement a contract would reconstruct from the session and submission.
pub fn statement(
    input: &PlayInput,
    chart: &ChartRecord,
    mode: Mode,
    srs_id: [u8; 32],
    trace_commitment: Option<G1Affine>,
) -> Statement {
    let (digest, tc) = match mode {
        Mode::Calldata => (session_digest(&input.header, &input.footer), None),
        Mode::Committed => {
            let tc = trace_commitment.expect("mode B requires the device trace commitment");
            let d = session_digest_v2(
                &input.header,
                input.footer.event_count,
                input.footer.duration_us,
                &input.footer.trace_root,
                &tc,
            );
            (d, Some(tc))
        }
    };
    Statement {
        mode,
        session_digest: digest,
        n: input.events.len() as u64,
        duration: input.footer.duration_us,
        chart: chart.clone(),
        trace_commitment: tc,
        srs_id,
    }
}

/// Header as a mode-B session would carry it (different input policy).
pub fn mode_b_header(h: &SessionHeader) -> SessionHeader {
    let mut h = h.clone();
    h.input_policy_hash = input_policy_v2();
    h
}

pub struct Proved {
    pub witness: Witness,
    pub statement: Statement,
    pub proof: ScoreProof,
    pub timings: Timings,
}

pub fn prove(srs: &Srs, input: &PlayInput, chart: &ChartRecord, mode: Mode) -> Result<Proved> {
    let t = std::time::Instant::now();
    let w = witness::build_from_input(input)?;
    let witness_ms = t.elapsed().as_secs_f64() * 1e3;
    let (input_b, tc);
    let input_ref = match mode {
        Mode::Calldata => {
            tc = None;
            input
        }
        Mode::Committed => {
            input_b = PlayInput {
                header: mode_b_header(&input.header),
                ..input.clone()
            };
            tc = Some(device_trace_commitment(srs, &input.events));
            &input_b
        }
    };
    let st = statement(input_ref, chart, mode, srs.vk().id(), tc);
    let (proof, mut timings) = prover::prove(&w, &st, srs, &input.events)?;
    timings.witness_ms = witness_ms;
    timings.total_ms += witness_ms;
    Ok(Proved {
        witness: w,
        statement: st,
        proof,
        timings,
    })
}

pub fn verify(
    vk: &VerifierKey,
    st: &Statement,
    proof: &ScoreProof,
    events: Option<&[InputEvent]>,
) -> Result<VerifiedScore> {
    verifier::verify(st, proof, vk, events)
}
