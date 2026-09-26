//! Calldata encoding of proofs (uint256[] words) consumed by the Solidity verifier.
use super::layout::{claim_columns, Shape};
use super::relation::byte;
use super::{Mode, ScoreProof};
use crate::field::{fe_from_be, fe_to_be, g1_from_words, g1_to_words, Field, G1Affine, Word, F};
use crate::logup_gkr::{GkrProof, LayerProof};
use crate::mle::log2_ceil;
use crate::zeromorph::ZmProof;
use anyhow::{ensure, Context, Result};

/// Layout: C_A | GKR (layer1, then per layer: rounds×3, children×4) | row rounds×4 |
/// claims | reduction rounds×2 | adv_eval, chart_eval[, trace_eval] | q_0..q_{A-1}, q̂, q̂', π.
/// lane_bits and counts travel as separate ABI arguments.
pub fn proof_words(p: &ScoreProof) -> Vec<Word> {
    let mut w: Vec<Word> = Vec::new();
    w.extend(g1_to_words(&p.adv_commitment));
    let fe = |w: &mut Vec<Word>, xs: &[F]| w.extend(xs.iter().map(fe_to_be));
    fe(&mut w, &p.gkr.layer1);
    for l in &p.gkr.layers {
        for r in &l.rounds {
            fe(&mut w, r);
        }
        fe(&mut w, &l.children);
    }
    for r in &p.row_rounds {
        fe(&mut w, r);
    }
    fe(&mut w, &p.claims);
    for r in &p.red_rounds {
        fe(&mut w, r);
    }
    fe(&mut w, &[p.adv_eval, p.chart_eval]);
    if let Some(t) = p.trace_eval {
        fe(&mut w, &[t]);
    }
    for q in
        p.zm.q
            .iter()
            .chain([&p.zm.qhat, &p.zm.qhat_shift, &p.zm.pi])
    {
        w.extend(g1_to_words(q));
    }
    w
}

pub fn shape_for(lane_bits: &[u64; 4], chart_bits: u64, n: u64) -> Shape {
    Shape {
        bits: [
            lane_bits[0] as usize,
            lane_bits[1] as usize,
            lane_bits[2] as usize,
            lane_bits[3] as usize,
            chart_bits as usize,
            log2_ceil(n as usize + 1),
            byte::BITS,
        ],
    }
}

struct Cursor<'a> {
    words: &'a [Word],
    pos: usize,
}

impl Cursor<'_> {
    fn fe(&mut self) -> Result<F> {
        let w = self.words.get(self.pos).context("proof too short")?;
        self.pos += 1;
        fe_from_be(w).context("non-canonical field element")
    }
    fn fes<const N: usize>(&mut self) -> Result<[F; N]> {
        let mut out = [F::ZERO; N];
        for x in out.iter_mut() {
            *x = self.fe()?;
        }
        Ok(out)
    }
    fn vec(&mut self, n: usize) -> Result<Vec<F>> {
        (0..n).map(|_| self.fe()).collect()
    }
    fn point(&mut self) -> Result<G1Affine> {
        ensure!(self.pos + 2 <= self.words.len(), "proof too short");
        let p = g1_from_words(&[self.words[self.pos], self.words[self.pos + 1]])
            .context("invalid G1 point")?;
        self.pos += 2;
        Ok(p)
    }
}

pub fn decode(
    words: &[Word],
    lane_bits: [u64; 4],
    counts: [u64; 5],
    chart_bits: u64,
    n: u64,
    mode: Mode,
) -> Result<ScoreProof> {
    let shape = shape_for(&lane_bits, chart_bits, n);
    let (_, g) = shape.leaf_layout();
    let a = shape.opening_vars();
    let mut c = Cursor { words, pos: 0 };
    let adv_commitment = c.point()?;
    let layer1 = c.fes::<4>()?;
    let mut layers = Vec::with_capacity(g.saturating_sub(1));
    for k in 1..g {
        let rounds = (0..k).map(|_| c.fes::<3>()).collect::<Result<Vec<_>>>()?;
        let children = c.fes::<4>()?;
        layers.push(LayerProof { rounds, children });
    }
    let row_rounds = (0..shape.r_max())
        .map(|_| c.fes::<4>())
        .collect::<Result<Vec<_>>>()?;
    let claims = c.vec(claim_columns().len())?;
    let red_rounds = (0..a).map(|_| c.fes::<2>()).collect::<Result<Vec<_>>>()?;
    let adv_eval = c.fe()?;
    let chart_eval = c.fe()?;
    let trace_eval = if mode == Mode::Committed {
        Some(c.fe()?)
    } else {
        None
    };
    let q = (0..a).map(|_| c.point()).collect::<Result<Vec<_>>>()?;
    let qhat = c.point()?;
    let qhat_shift = c.point()?;
    let pi = c.point()?;
    ensure!(c.pos == words.len(), "trailing proof words");
    Ok(ScoreProof {
        lane_bits,
        counts,
        adv_commitment,
        gkr: GkrProof { layer1, layers },
        row_rounds,
        claims,
        red_rounds,
        adv_eval,
        chart_eval,
        trace_eval,
        zm: ZmProof {
            q,
            qhat,
            qhat_shift,
            pi,
        },
    })
}
