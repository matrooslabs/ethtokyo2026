//! GKR proving kept in memory: the SRS is loaded once at start.
use crate::http::Prove;
use anyhow::{bail, Result};
use mania_gkr::field::{g1_to_words, words_to_hex};
use mania_gkr::scoring::{api, encode, session::register_chart, Mode};
use mania_gkr::zeromorph::Srs;
use mania_scoring_core::PlayInput;
use serde_json::{json, Value};

pub struct GkrProver {
    srs: Srs,
    srs_id: String,
}

impl GkrProver {
    pub fn new(srs: Srs) -> Self {
        let srs_id = format!("0x{}", hex::encode(srs.vk().id()));
        Self { srs, srs_id }
    }
}

impl Prove for GkrProver {
    fn info(&self) -> Value {
        json!({"system": "gkr", "srsId": self.srs_id, "srsSmax": self.srs.smax, "modes": self.modes()})
    }

    /// `calldata` = mode A (`submitCalldata`), `committed` = mode B (`submitCommitted`).
    fn modes(&self) -> &'static [&'static str] {
        &["calldata", "committed"]
    }

    /// Same output as `mania-gkr prove`, verified natively before it is returned.
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
            "proof": words_to_hex(&encode::proof_words(&p.proof)),
            "chartCommitment": words_to_hex(&g1_to_words(&reg.record.commitment)),
            "traceCommitment": p.statement.trace_commitment.map(|c| words_to_hex(&g1_to_words(&c))),
            "sessionDigest": format!("0x{}", hex::encode(p.statement.session_digest)),
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
        let prover = GkrProver::new(Srs::insecure_dev(16, 1));
        for mode in ["calldata", "committed"] {
            let proof = prover.prove(mode, &play).unwrap();
            assert_eq!(proof["result"]["score"], expected.score);
            assert_eq!(proof["result"]["judgements"], json!(expected.judgements));
            assert!(proof["proof"].as_array().unwrap().len() > 100);
            assert_eq!(proof["traceCommitment"].is_null(), mode == "calldata");
        }
    }
}
