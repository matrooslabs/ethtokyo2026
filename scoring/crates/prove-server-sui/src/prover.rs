//! GKR (BLS12-381, Sui) proving kept in memory: the SRS is loaded once at start.
use crate::http::Prove;
use anyhow::{bail, Result};
use mania_gkr_sui::field::{g1_to_bytes, hex0x};
use mania_gkr_sui::scoring::{api, encode, session::register_chart, Mode};
use mania_gkr_sui::zeromorph::Srs;
use mania_scoring_core::PlayInput;
use serde_json::{json, Value};

pub struct SuiProver {
    srs: Srs,
    srs_id: String,
}

impl SuiProver {
    pub fn new(srs: Srs) -> Self {
        let srs_id = hex0x(&srs.vk().id());
        Self { srs, srs_id }
    }
}

impl Prove for SuiProver {
    fn info(&self) -> Value {
        json!({"system": "gkr-sui", "srsId": self.srs_id, "srsSmax": self.srs.smax, "modes": self.modes()})
    }

    /// `calldata` = mode A (trace submitted in chunks), `committed` = mode B (device trace commitment).
    fn modes(&self) -> &'static [&'static str] {
        &["calldata", "committed"]
    }

    /// Same output as `mania-gkr-sui prove`, verified natively before it is returned.
    fn prove(&self, mode: &str, input: &PlayInput) -> Result<Value> {
        let mode = match mode {
            "calldata" => Mode::Calldata,
            "committed" => Mode::Committed,
            _ => bail!("unsupported mode"),
        };
        let reg = register_chart(&self.srs, &input.chart)?;
        let p = api::prove(&self.srs, input, &reg.record, mode)?;
        let events = (mode == Mode::Calldata).then_some(&input.events[..]);
        let result = api::verify(&self.srs.vk(), &p.statement, &p.proof, events)?;
        Ok(json!({
            "mode": format!("{mode:?}"), "srsId": self.srs_id, "result": result, "timings": p.timings,
            "laneBits": p.proof.lane_bits, "counts": p.proof.counts,
            "proof": hex0x(&encode::proof_bytes(&p.proof)),
            "chartCommitment": hex0x(&g1_to_bytes(&reg.record.commitment)),
            "traceCommitment": p.statement.trace_commitment.map(|c| hex0x(&g1_to_bytes(&c))),
            "sessionDigest": hex0x(&p.statement.session_digest),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mania_scoring_core::evaluate;

    #[test]
    fn proves_both_modes_with_the_native_score() {
        let play: PlayInput =
            serde_json::from_str(include_str!("../../../fixtures/demo.json")).unwrap();
        let expected = evaluate(&play).unwrap();
        let prover = SuiProver::new(Srs::insecure_dev(16, 1));
        for mode in ["calldata", "committed"] {
            let proof = prover.prove(mode, &play).unwrap();
            assert_eq!(proof["result"]["score"], expected.score);
            assert_eq!(proof["result"]["judgements"], json!(expected.judgements));
            assert!(proof["proof"].as_str().unwrap().len() > 1000);
            assert_eq!(proof["traceCommitment"].is_null(), mode == "calldata");
        }
    }
}
