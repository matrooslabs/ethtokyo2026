//! Native verifier; the Solidity verifier implements the same steps (SPEC §7.2).
use super::layout::{claim_columns, one_minus_sum, Shape};
use super::relation::{
    self, byte, chart as ch, trace as trc, Consts, Fp, Kind, TableBatch, KINDS, MAX_LANE_BITS, W,
};
use super::witness::trace_rowmajor;
use super::{absorb_statement, score, Mode, ScoreProof, Statement, DOMAIN};
use crate::field::{Curve, Field, PrimeCurveAffine, F};
use crate::logup_gkr;
use crate::mle::{eq_const, eq_eval, id_mle, log2_ceil, mle_eval, pad_factor, step_mle};
use crate::poly::{decompress, interpolate};
use crate::transcript::Transcript;
use crate::zeromorph::{self, VerifierKey};
use anyhow::{bail, ensure, Result};
use mania_scoring_core::{InputEvent, MAX_DURATION_US, MAX_EVENTS, MAX_NOTES};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VerifiedScore {
    pub score: u64,
    pub achieved_points: u64,
    pub maximum_points: u64,
    /// PERFECT, GREAT, GOOD, OK, MEH, MISS
    pub judgements: [u64; 6],
}

/// Public column values of table `kind` at y (its own row variables).
pub fn public_values(kind: Kind, y: &[F], st: &Statement) -> Vec<F> {
    match kind {
        Kind::Lane(_) => vec![
            y.iter().map(|&x| F::ONE - x).product(),
            y.iter().copied().product(),
            id_mle(y),
        ],
        Kind::Chart => vec![step_mle(st.chart.m, y)],
        Kind::Trace => vec![
            step_mle(st.n, y),
            eq_const(st.n, y),
            y.iter().map(|&x| F::ONE - x).product(),
            id_mle(y),
        ],
        Kind::Byte => vec![id_mle(y)],
    }
}

pub fn verify(
    st: &Statement,
    proof: &ScoreProof,
    vk: &VerifierKey,
    events: Option<&[InputEvent]>,
) -> Result<VerifiedScore> {
    // Native statement checks (SPEC §4).
    ensure!(st.n as usize <= MAX_EVENTS, "too many events");
    ensure!(
        st.chart.m >= 1 && st.chart.m as usize <= MAX_NOTES,
        "invalid chart size"
    );
    ensure!(
        st.chart.bits as usize == log2_ceil(st.chart.m as usize),
        "invalid chart bits"
    );
    ensure!(
        st.duration <= MAX_DURATION_US && st.duration >= st.chart.max_end + W,
        "duration does not cover chart"
    );
    ensure!(
        proof.lane_bits.iter().all(|&b| b as usize <= MAX_LANE_BITS),
        "lane table too large"
    );
    ensure!(st.srs_id == vk.id(), "proof bound to a different SRS");
    let (score, achieved, maximum, misses) = score(&proof.counts, st.chart.components)
        .ok_or_else(|| anyhow::anyhow!("counts exceed components"))?;
    let shape = Shape {
        bits: [
            proof.lane_bits[0] as usize,
            proof.lane_bits[1] as usize,
            proof.lane_bits[2] as usize,
            proof.lane_bits[3] as usize,
            st.chart.bits as usize,
            log2_ceil(st.n as usize + 1),
            byte::BITS,
        ],
    };
    let a_vars = shape.opening_vars();
    ensure!(a_vars <= vk.smax, "instance exceeds SRS size");

    let mut tr = Transcript::new(DOMAIN);
    absorb_statement(
        &mut tr,
        st,
        &proof.lane_bits,
        &proof.counts,
        &proof.adv_commitment,
    );
    let fp = Fp::new(tr.squeeze(), tr.squeeze());

    // GKR over leaves.
    let (_, g) = shape.leaf_layout();
    let gout = logup_gkr::verify(&proof.gkr, g, &mut tr)?;

    // Row sumcheck.
    let lambda = tr.squeeze();
    let beta = tr.squeeze();
    let zeta = tr.squeeze();
    let kappa = tr.squeeze();
    let r_max = shape.r_max();
    let r = tr.squeeze_n(r_max);
    let chi = shape.chi(&gout.point);
    let mut kz = [F::ZERO; 5];
    let mut zp = kappa;
    for c in 0..5 {
        kz[c] = zp;
        zp *= zeta;
    }
    let count_claim: F = (0..5).map(|c| kz[c] * F::from(proof.counts[c])).sum();
    let mut claim = gout.p + lambda * (gout.q - one_minus_sum(&chi)) + count_claim;
    ensure!(
        proof.row_rounds.len() == r_max,
        "wrong number of row sumcheck rounds"
    );
    let mut r_prime = Vec::with_capacity(r_max);
    for sent in &proof.row_rounds {
        tr.absorb(sent);
        let evals = decompress(claim, sent);
        let x = tr.squeeze();
        claim = interpolate(&evals, x);
        r_prime.push(x);
    }
    let cols = claim_columns();
    ensure!(
        proof.claims.len() == cols.len(),
        "wrong number of column claims"
    );
    tr.absorb(&proof.claims);

    // Recompute F(r').
    let total_c = shape.total_constraints();
    let mut beta_pows = vec![F::ONE; total_c];
    for i in 1..total_c {
        beta_pows[i] = beta_pows[i - 1] * beta;
    }
    let offsets = shape.constraint_offsets();
    let consts = Consts {
        duration: F::from(st.duration),
    };
    let eq_r = eq_eval(&r, &r_prime);
    let mut expected = F::ZERO;
    let mut cursor = 0;
    for (t, &kind) in KINDS.iter().enumerate() {
        let bits = shape.bits[t];
        let y = &r_prime[..bits];
        let pad = pad_factor(&r_prime, bits);
        let n_claims = kind.adv() + kind.src();
        let mut v: Vec<F> = proof.claims[cursor..cursor + n_claims]
            .iter()
            .map(|c| *c * pad)
            .collect();
        cursor += n_claims;
        v.extend(public_values(kind, y, st).into_iter().map(|p| p * pad));
        let eq_z = eq_eval(&gout.point[..bits], y) * pad;
        let batch = TableBatch {
            kind,
            fp,
            consts,
            beta: &beta_pows[offsets[t]..offsets[t] + kind.constraints()],
            chi: &chi[t],
            lambda,
            kappa_zeta: kz,
        };
        expected += relation::table_poly(&batch, &v, eq_r, eq_z);
    }
    ensure!(claim == expected, "row sumcheck final check failed");

    // Opening reduction.
    let mu = tr.squeeze();
    ensure!(
        proof.red_rounds.len() == a_vars,
        "wrong number of reduction rounds"
    );
    let mut red_claim = F::ZERO;
    let mut mu_pow = F::ONE;
    let mut mu_list = Vec::with_capacity(cols.len());
    for c in &proof.claims {
        red_claim += mu_pow * c;
        mu_list.push(mu_pow);
        mu_pow *= mu;
    }
    let mut z_star = Vec::with_capacity(a_vars);
    for sent in &proof.red_rounds {
        tr.absorb(sent);
        let evals = decompress(red_claim, sent);
        let x = tr.squeeze();
        red_claim = interpolate(&evals, x);
        z_star.push(x);
    }
    let (blocks, _) = shape.adv_layout();
    let (mut w_a, mut w_n, mut w_e) = (F::ZERO, F::ZERO, F::ZERO);
    for (i, &(t, c)) in cols.iter().enumerate() {
        let kind = KINDS[t];
        let bits = shape.bits[t];
        let row_eq = |shift: usize| eq_eval(&r_prime[..bits], &z_star[shift..shift + bits]);
        if c < kind.adv() {
            let b = blocks.iter().find(|b| b.table == t).unwrap();
            let hi = b.row_bits + b.col_log;
            w_a += mu_list[i]
                * eq_const((b.offset >> hi) as u64, &z_star[hi..])
                * eq_const(c as u64, &z_star[b.row_bits..hi])
                * row_eq(0);
        } else {
            let sc = (c - kind.adv()) as u64;
            let slots_log = if kind == Kind::Chart {
                ch::SRC_SLOTS_LOG
            } else {
                trc::SRC_SLOTS_LOG
            };
            let term = mu_list[i]
                * eq_const(sc, &z_star[..slots_log])
                * row_eq(slots_log)
                * pad_factor(&z_star, slots_log + bits);
            if kind == Kind::Chart {
                w_n += term;
            } else {
                w_e += term;
            }
        }
    }
    let trace_eval = match st.mode {
        Mode::Calldata => {
            ensure!(
                proof.trace_eval.is_none(),
                "mode A proofs carry no trace evaluation"
            );
            let ev = events.ok_or_else(|| anyhow::anyhow!("mode A requires the calldata trace"))?;
            ensure!(ev.len() as u64 == st.n, "trace length mismatch");
            mle_eval(&trace_rowmajor(ev), &z_star)
        }
        Mode::Committed => proof
            .trace_eval
            .ok_or_else(|| anyhow::anyhow!("mode B requires a trace evaluation"))?,
    };
    ensure!(
        red_claim == proof.adv_eval * w_a + proof.chart_eval * w_n + trace_eval * w_e,
        "opening reduction final check failed"
    );
    let mut finals = vec![proof.adv_eval, proof.chart_eval];
    finals.extend(proof.trace_eval);
    tr.absorb(&finals);

    // Batched Zeromorph opening.
    let nu = tr.squeeze();
    let mut commitment = proof.adv_commitment.to_curve() + st.chart.commitment * nu;
    let mut value = proof.adv_eval + nu * proof.chart_eval;
    if st.mode == Mode::Committed {
        let ce = st
            .trace_commitment
            .ok_or_else(|| anyhow::anyhow!("mode B requires a trace commitment"))?;
        commitment += ce * (nu * nu);
        value += nu * nu * trace_eval;
    }
    let commitment = commitment.to_affine();
    if bool::from(commitment.is_identity()) && value != F::ZERO {
        bail!("identity commitment");
    }
    zeromorph::verify(vk, commitment, &z_star, value, &proof.zm, &mut tr)?;

    let c = proof.counts;
    Ok(VerifiedScore {
        score,
        achieved_points: achieved,
        maximum_points: maximum,
        judgements: [c[0], c[1], c[2], c[3], c[4], misses],
    })
}
