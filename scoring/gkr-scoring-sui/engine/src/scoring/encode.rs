//! Wire encoding of proofs (a list of 32/48-byte items) consumed by the Move verifier.
use super::layout::{claim_columns, Shape};
use super::relation::byte;
use super::{Mode, ScoreProof};
use crate::field::{fe_from_be, fe_to_be, g1_from_bytes, g1_to_bytes, Field, G1Affine, Word, F};
use crate::logup_gkr::{GkrProof, LayerProof};
use crate::mle::log2_ceil;
use crate::zeromorph::ZmProof;
use anyhow::{ensure, Context, Result};

/// Items in order: C_A | GKR (layer1, then per layer: rounds×3, children×4) | row rounds×4 |
/// claims | reduction rounds×2 | adv_eval, chart_eval[, trace_eval] | q_0..q_{A-1}, q̂, q̂', π.
/// Scalars are 32-byte big-endian items, points 48-byte compressed items. On Sui the list
/// travels as `vector<vector<u8>>` groups (≤16 KiB per PTB argument); lane_bits and counts
/// are separate arguments.
pub fn proof_items(p: &ScoreProof) -> Vec<Vec<u8>> {
    let mut w: Vec<Vec<u8>> = Vec::new();
    w.push(g1_to_bytes(&p.adv_commitment).to_vec());
    let fe = |w: &mut Vec<Vec<u8>>, xs: &[F]| w.extend(xs.iter().map(|x| fe_to_be(x).to_vec()));
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
        w.push(g1_to_bytes(q).to_vec());
    }
    w
}

/// Concatenated items (size accounting).
pub fn proof_bytes(p: &ScoreProof) -> Vec<u8> {
    proof_items(p).concat()
}

/// Splits items into groups whose BCS encoding fits one 16 KiB pure argument.
pub fn group_items(items: &[Vec<u8>], max_bytes: usize) -> Vec<Vec<Vec<u8>>> {
    let mut out: Vec<Vec<Vec<u8>>> = vec![Vec::new()];
    let mut size = 3;
    for it in items {
        let cost = it.len() + 2;
        if size + cost > max_bytes && !out.last().unwrap().is_empty() {
            out.push(Vec::new());
            size = 3;
        }
        out.last_mut().unwrap().push(it.clone());
        size += cost;
    }
    out
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
    items: &'a [Vec<u8>],
    pos: usize,
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8]> {
        let it = self.items.get(self.pos).context("proof too short")?;
        ensure!(it.len() == n, "wrong item length");
        self.pos += 1;
        Ok(it)
    }
    fn fe(&mut self) -> Result<F> {
        let w: Word = self.take(32)?.try_into().unwrap();
        fe_from_be(&w).context("non-canonical field element")
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
        g1_from_bytes(self.take(48)?).context("invalid G1 point")
    }
}

pub fn decode(
    items: &[Vec<u8>],
    lane_bits: [u64; 4],
    counts: [u64; 5],
    chart_bits: u64,
    n: u64,
    mode: Mode,
) -> Result<ScoreProof> {
    let shape = shape_for(&lane_bits, chart_bits, n);
    let (_, g) = shape.leaf_layout();
    let a = shape.opening_vars();
    let mut c = Cursor { items, pos: 0 };
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
    ensure!(c.pos == items.len(), "trailing proof items");
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
