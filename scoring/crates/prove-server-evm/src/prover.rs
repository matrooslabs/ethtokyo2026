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

    fn bank_hash(&self, points: usize) -> Result<[u8; 32]> {
        anyhow::ensure!(
            points > 0 && points <= self.srs.g1.len(),
            "bank exceeds SRS"
        );
        let bank: Vec<u8> = self.srs.g1[..points]
            .iter()
            .flat_map(|p| g1_to_words(p).into_iter().flatten())
            .collect();
        Ok(mania_scoring_core::sha256(&bank))
    }

    fn prove_sealed(&self, input: &PlayInput, commitment: [[u8; 32]; 2]) -> Result<Value> {
        use mania_gkr::scoring::{prover, witness};
        anyhow::ensure!(
            input.header.input_policy_hash == mania_gkr::scoring::session::input_policy_v2(),
            "not Mode B"
        );
        mania_scoring_core::evaluate_with_policy(
            input,
            mania_gkr::scoring::session::input_policy_v2(),
        )
        .map_err(anyhow::Error::msg)?;
        let tc = api::device_trace_commitment(&self.srs, &input.events);
        anyhow::ensure!(
            g1_to_words(&tc) == commitment,
            "original hardware commitment mismatch"
        );
        let reg = register_chart(&self.srs, &input.chart)?;
        let st = api::statement(
            input,
            &reg.record,
            Mode::Committed,
            self.srs.vk().id(),
            Some(tc),
        );
        let w = witness::build_from_input(input)?;
        let (proof, timings) = prover::prove(&w, &st, &self.srs, &input.events)?;
        let result = api::verify(&self.srs.vk(), &st, &proof, None)?;
        Ok(
            json!({"srsId":self.srs_id,"sessionDigest":format!("0x{}",hex::encode(st.session_digest)),
            "laneBits":proof.lane_bits,"counts":proof.counts,"proof":words_to_hex(&encode::proof_words(&proof)),
            "traceCommitment":words_to_hex(&commitment),"result":result,"timings":timings}),
        )
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

#[cfg(test)]
mod sealed_tests {
    use super::*;
    use crate::capture::{packed_header, parse_osu, Capture};
    use alloy::{
        primitives::B256,
        signers::{local::PrivateKeySigner, SignerSync},
    };
    use mania_scoring_core::{trace_root, InputEvent, SessionFooter};
    #[test]
    fn original_seals_and_identity_are_proved_without_header_rewriting() {
        let srs = Srs::insecure_dev(18, 1);
        let prover = GkrProver::new(srs);
        let chart = parse_osu(
            b"[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,500,1,0\n",
        )
        .unwrap();
        let signer: PrivateKeySigner = format!("{:064x}", 77).parse().unwrap();
        for n in [0, 1, 31, 32, 33, 64, 65] {
            let mut input: PlayInput =
                serde_json::from_str(include_str!("../../../fixtures/demo.json")).unwrap();
            input.header.input_policy_hash = mania_gkr::scoring::session::input_policy_v2();
            input.header.device = signer.address().into_array();
            input.chart = chart.chart.clone();
            input.header.chart_hash = mania_scoring_core::chart_hash(&input.chart);
            input.events = (0..n)
                .map(|i| InputEvent {
                    sequence: i,
                    timestamp_us: 0,
                    lane: 0,
                    action: (i % 2) as u8,
                })
                .collect();
            input.footer = SessionFooter {
                event_count: n,
                duration_us: 700000,
                trace_root: trace_root(&input.header.session_id, &input.events),
            };
            let tc = api::device_trace_commitment(&prover.srs, &input.events);
            let words = g1_to_words(&tc);
            if n <= 1 {
                assert_eq!(words, [[0; 32]; 2]);
            }
            let digest = mania_gkr::scoring::session::session_digest_v2(
                &input.header,
                n,
                700000,
                &input.footer.trace_root,
                &tc,
            );
            let sig = signer
                .sign_hash_sync(&B256::from(digest))
                .unwrap()
                .as_bytes();
            let mut result = packed_header(&input.header);
            result.extend(n.to_be_bytes());
            result.extend(700000u64.to_be_bytes());
            result.extend(input.footer.trace_root);
            result.extend(words.into_iter().flatten());
            result.extend(sig);
            let capture = Capture {
                result: format!("0x{}", hex::encode(&result)),
                trace: format!("0x{}", hex::encode(mania_gkr::forge::events_bytes(&input))),
                web_beatmap_hash: chart.web_hash.clone(),
            };
            capture.decode(&input.header, &chart, 65).unwrap();
            for index in [0, 292, 303, 304, 336, 400, 464] {
                let mut bad = result.clone();
                bad[index] ^= 1;
                let changed = Capture {
                    result: format!("0x{}", hex::encode(bad)),
                    ..capture.clone()
                };
                assert!(
                    changed.decode(&input.header, &chart, 65).is_err(),
                    "byte {index}"
                );
            }
            if n == 0 || n == 65 {
                let proof = prover.prove_sealed(&input, words).unwrap();
                assert_eq!(proof["sessionDigest"], format!("0x{}", hex::encode(digest)));
            }
            let mut wrong = words;
            wrong[0][0] ^= 1;
            assert!(prover.prove_sealed(&input, wrong).is_err());
            let mut wrong = input.clone();
            wrong.header.input_policy_hash = [0; 32];
            assert!(prover.prove_sealed(&wrong, words).is_err());
        }
    }
}
