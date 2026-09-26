//! The scoring relation (SPEC §5–6): column layouts, polynomial constraints and logUp
//! slots. These functions are the single source of truth for the prover (evaluated per
//! row and at interpolation points) and the native verifier (evaluated at r').
use crate::field::{Field, F};

pub const W: u64 = 136_500;
pub const S16: u64 = 1 << 16;
pub const HEAD_LO: [u64; 5] = [0, 19_501, 49_501, 82_501, 112_501];
pub const HEAD_HI: [u64; 5] = [19_500, 49_500, 82_500, 112_500, 136_500];
pub const TAIL_LO: [u64; 6] = [0, 19_501, 49_501, 82_501, 112_501, 136_501];
pub const TAIL_HI: [u64; 6] = [19_500, 49_500, 82_500, 112_500, 136_500, (1 << 32) - 1];
pub const MAX_LANE_BITS: usize = 17;

/// Table order used everywhere: lanes 0..3, chart, trace, byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Lane(u8),
    Chart,
    Trace,
    Byte,
}

pub const KINDS: [Kind; 7] = [
    Kind::Lane(0),
    Kind::Lane(1),
    Kind::Lane(2),
    Kind::Lane(3),
    Kind::Chart,
    Kind::Trace,
    Kind::Byte,
];

// ---- column indices -------------------------------------------------------------------

pub mod lane {
    pub const IS_O: usize = 0;
    pub const IS_C: usize = 1;
    pub const IS_D: usize = 2;
    pub const IS_U: usize = 3;
    pub const V: usize = 4;
    pub const Q: usize = 5;
    pub const KL: usize = 6;
    pub const O: usize = 7;
    pub const F: usize = 8;
    pub const H: usize = 9;
    pub const A: usize = 10;
    pub const KX: usize = 11;
    pub const LAST_K: usize = 12;
    pub const INV: usize = 13;
    pub const MD: usize = 14;
    pub const CC: usize = 15;
    pub const LIMB: usize = 16; // 7 limbs
    pub const ADV: usize = 23;
    pub const SRC: usize = 0;
    // public
    pub const IS_FIRST: usize = 23;
    pub const IS_LAST: usize = 24;
    pub const ID: usize = 25;
    pub const PUB: usize = 3;
    pub const SLOTS: usize = 12;
    pub const CONSTRAINTS: usize = 23;
    pub const COL_SLOTS_LOG: usize = 5;
}

pub mod chart {
    pub const HIT: usize = 0;
    pub const TH: usize = 1;
    pub const REL: usize = 2;
    pub const U: usize = 3;
    pub const HH: usize = 4;
    pub const SIGMA: usize = 5;
    pub const H0: usize = 6; // h0..h4
    pub const TAU: usize = 11;
    pub const G0: usize = 12; // g0..g5
    pub const LIMB: usize = 18; // 14 limbs
    pub const ADV: usize = 32;
    // source
    pub const LANE: usize = 32;
    pub const S: usize = 33;
    pub const E: usize = 34;
    pub const HOLD: usize = 35;
    pub const KL: usize = 36;
    pub const SRC: usize = 5;
    // public
    pub const REAL: usize = 37;
    pub const PUB: usize = 1;
    pub const SLOTS: usize = 18;
    pub const CONSTRAINTS: usize = 25;
    pub const COL_SLOTS_LOG: usize = 5;
    /// Row-major source layout width in the CHART commitment (8 slots).
    pub const SRC_SLOTS_LOG: usize = 3;
}

pub mod trace {
    pub const P: usize = 0;
    pub const LIMB: usize = 1; // 4 limbs
    pub const ADV: usize = 5;
    // source
    pub const T: usize = 5;
    pub const LANE: usize = 6;
    pub const ACT: usize = 7;
    pub const SRC: usize = 3;
    // public
    pub const REAL: usize = 8;
    pub const IS_END: usize = 9;
    pub const IS_FIRST: usize = 10;
    pub const IDX: usize = 11;
    pub const PUB: usize = 4;
    pub const SLOTS: usize = 7;
    pub const CONSTRAINTS: usize = 3;
    pub const COL_SLOTS_LOG: usize = 3;
    /// Row-major source layout width in the TRACE commitment (4 slots).
    pub const SRC_SLOTS_LOG: usize = 2;
}

pub mod byte {
    pub const MU: usize = 0;
    pub const ADV: usize = 1;
    pub const SRC: usize = 0;
    pub const VAL: usize = 1;
    pub const PUB: usize = 1;
    pub const SLOTS: usize = 1;
    pub const CONSTRAINTS: usize = 0;
    pub const COL_SLOTS_LOG: usize = 0;
    pub const BITS: usize = 8;
}

impl Kind {
    pub fn index(self) -> usize {
        match self {
            Kind::Lane(l) => l as usize,
            Kind::Chart => 4,
            Kind::Trace => 5,
            Kind::Byte => 6,
        }
    }
    pub fn adv(self) -> usize {
        match self {
            Kind::Lane(_) => lane::ADV,
            Kind::Chart => chart::ADV,
            Kind::Trace => trace::ADV,
            Kind::Byte => byte::ADV,
        }
    }
    pub fn src(self) -> usize {
        match self {
            Kind::Lane(_) => lane::SRC,
            Kind::Chart => chart::SRC,
            Kind::Trace => trace::SRC,
            Kind::Byte => byte::SRC,
        }
    }
    pub fn public(self) -> usize {
        match self {
            Kind::Lane(_) => lane::PUB,
            Kind::Chart => chart::PUB,
            Kind::Trace => trace::PUB,
            Kind::Byte => byte::PUB,
        }
    }
    pub fn width(self) -> usize {
        self.adv() + self.src() + self.public()
    }
    pub fn slots(self) -> usize {
        match self {
            Kind::Lane(_) => lane::SLOTS,
            Kind::Chart => chart::SLOTS,
            Kind::Trace => trace::SLOTS,
            Kind::Byte => byte::SLOTS,
        }
    }
    pub fn constraints(self) -> usize {
        match self {
            Kind::Lane(_) => lane::CONSTRAINTS,
            Kind::Chart => chart::CONSTRAINTS,
            Kind::Trace => trace::CONSTRAINTS,
            Kind::Byte => byte::CONSTRAINTS,
        }
    }
    pub fn col_slots_log(self) -> usize {
        match self {
            Kind::Lane(_) => lane::COL_SLOTS_LOG,
            Kind::Chart => chart::COL_SLOTS_LOG,
            Kind::Trace => trace::COL_SLOTS_LOG,
            Kind::Byte => byte::COL_SLOTS_LOG,
        }
    }
}

/// Fingerprint powers α^0..α^8 and γ.
#[derive(Clone, Copy)]
pub struct Fp {
    pub alpha: [F; 9],
    pub gamma: F,
}

impl Fp {
    pub fn new(alpha: F, gamma: F) -> Self {
        let mut pows = [F::ONE; 9];
        for i in 1..9 {
            pows[i] = pows[i - 1] * alpha;
        }
        Fp { alpha: pows, gamma }
    }
    /// γ − (tag + Σ α^i a_i)
    #[inline]
    pub fn den(&self, tag: F, a: &[F]) -> F {
        let mut acc = tag;
        for (i, x) in a.iter().enumerate() {
            acc += self.alpha[i + 1] * x;
        }
        self.gamma - acc
    }
}

/// Per-table constants entering the polynomials.
#[derive(Clone, Copy)]
pub struct Consts {
    pub duration: F,
}

#[inline]
fn limbs(v: &[F], start: usize, count: usize) -> F {
    let mut acc = F::ZERO;
    for i in (0..count).rev() {
        acc = acc * F::from(256) + v[start + i];
    }
    acc
}

#[inline]
pub fn lane_sort_key(v: &[F]) -> F {
    use lane::*;
    let s = F::from(S16);
    let four_v = v[V] * F::from(4);
    let ev = v[IS_D] + v[IS_U];
    s * (four_v * v[IS_O]
        + (four_v + F::from(8 * W + 2)) * v[IS_C]
        + (four_v + F::from(4 * W + 1)) * ev)
        + v[Q] * ev
}

pub fn lane_constraints(v: &[F], out: &mut [F]) {
    use lane::*;
    let one = F::ONE;
    let is_real = v[IS_O] + v[IS_C] + v[IS_D] + v[IS_U];
    let k = lane_sort_key(v);
    let o_minus_f = v[O] - v[F];
    let f_minus_kl = v[F] - v[KL];
    out[0] = v[IS_O] * (v[IS_O] - one);
    out[1] = v[IS_C] * (v[IS_C] - one);
    out[2] = v[IS_D] * (v[IS_D] - one);
    out[3] = v[IS_U] * (v[IS_U] - one);
    out[4] = is_real * (is_real - one);
    out[5] = is_real * (k - v[LAST_K] - limbs(v, LIMB, 7));
    out[6] = v[IS_O] * (v[KL] - v[O]);
    out[7] = v[IS_D] * v[H];
    out[8] = v[IS_U] * (one - v[H]);
    out[9] = v[MD] * (v[MD] - one);
    out[10] = v[MD] * (one - v[IS_D]);
    out[11] = v[IS_D] * (one - v[MD]) * o_minus_f;
    out[12] = v[MD] * (o_minus_f * v[INV] - one);
    out[13] = v[CC] * (v[CC] - one);
    out[14] = v[CC] * (one - v[IS_C]);
    out[15] = v[CC] * f_minus_kl;
    // (isC − cC) = isC(1 − cC) given L15; keeps the degree at 3.
    out[16] = (v[IS_C] - v[CC]) * (f_minus_kl * v[INV] - one);
    for (i, col) in [O, F, H, A, KX, LAST_K].into_iter().enumerate() {
        out[17 + i] = v[IS_FIRST] * v[col];
    }
}

/// (p, q) per slot: ROW, MATCH, RELEASE, STATE_IN, STATE_OUT, LIMB0..6.
pub fn lane_slots(v: &[F], lane_id: F, fp: &Fp, out: &mut [(F, F)]) {
    use lane::*;
    let one = F::ONE;
    let zero = F::ZERO;
    let is_real = v[IS_O] + v[IS_C] + v[IS_D] + v[IS_U];
    let tag = v[IS_O] + v[IS_C].double() + v[IS_D] * F::from(3) + v[IS_U] * F::from(4);
    out[0] = (is_real, fp.den(tag, &[lane_id, v[V], v[Q], v[KL]]));
    out[1] = (v[MD], fp.den(F::from(5), &[lane_id, v[V], zero, v[F]]));
    out[2] = (
        v[IS_U] * v[A],
        fp.den(F::from(6), &[lane_id, v[V], zero, v[KX]]),
    );
    out[3] = (
        v[IS_FIRST] - one,
        fp.den(
            F::from(7),
            &[lane_id, v[ID], v[O], v[F], v[H], v[A], v[KX], v[LAST_K]],
        ),
    );
    let not_event = one - v[IS_D] - v[IS_U];
    let k = lane_sort_key(v);
    let next = [
        lane_id,
        v[ID] + one,
        v[O] + v[IS_O],
        v[F] + v[MD] + v[CC],
        v[H] + v[IS_D] - v[IS_U],
        not_event * v[A] + v[MD],
        not_event * v[KX] + v[MD] * v[F],
        v[LAST_K] + is_real * (k - v[LAST_K]),
    ];
    out[4] = (one - v[IS_LAST], fp.den(F::from(7), &next));
    for i in 0..7 {
        out[5 + i] = (one, fp.den(F::from(9), &[v[LIMB + i]]));
    }
}

pub fn chart_constraints(v: &[F], out: &mut [F]) {
    use chart::*;
    let one = F::ONE;
    let two = F::from(2);
    out[0] = v[HIT] * (v[HIT] - one);
    out[1] = v[REL] * (v[REL] - one);
    out[2] = v[REL] * (one - v[HIT]);
    out[3] = v[HIT] * (one - v[REAL]);
    out[4] = v[HH] - v[HIT] * v[HOLD];
    out[5] = v[SIGMA] * (v[SIGMA] - one);
    let mut sum_h = F::ZERO;
    let mut lo = F::ZERO;
    let mut hi = F::ZERO;
    for c in 0..5 {
        let h = v[H0 + c];
        out[6 + c] = h * (h - one);
        sum_h += h;
        lo += h * F::from(HEAD_LO[c]);
        hi += h * F::from(HEAD_HI[c]);
    }
    out[11] = sum_h - v[HIT];
    let delta = (two * v[SIGMA] - one) * (v[TH] - v[S]);
    out[12] = delta - lo - limbs(v, LIMB, 3);
    out[13] = hi - delta - limbs(v, LIMB + 3, 3);
    out[14] = v[TAU] * (v[TAU] - one);
    let mut sum_g = F::ZERO;
    let mut lo2 = F::ZERO;
    let mut hi2 = F::ZERO;
    for c in 0..6 {
        let g = v[G0 + c];
        out[15 + c] = g * (g - one);
        sum_g += g;
        lo2 += g * F::from(TAIL_LO[c]);
        hi2 += g * F::from(TAIL_HI[c]);
    }
    out[21] = sum_g - v[HH];
    out[22] = v[HH] * (one - v[REL]) * (one - v[G0 + 5]);
    let delta2 = v[HOLD] * (two * v[TAU] - one) * (v[U] - v[E]);
    out[23] = delta2 - lo2 - limbs(v, LIMB + 6, 4);
    out[24] = hi2 - delta2 - limbs(v, LIMB + 10, 4);
}

/// ζ-batched non-MISS counts contributed by one chart row.
pub fn chart_counts(v: &[F], zeta: &[F; 5]) -> F {
    use chart::*;
    (0..5).map(|c| zeta[c] * (v[H0 + c] + v[G0 + c])).sum()
}

/// OPEN, CLOSE, MATCH, RELEASE, LIMB0..13.
pub fn chart_slots(v: &[F], fp: &Fp, out: &mut [(F, F)]) {
    use chart::*;
    let zero = F::ZERO;
    let neg_real = -v[REAL];
    out[0] = (neg_real, fp.den(F::ONE, &[v[LANE], v[S], zero, v[KL]]));
    out[1] = (neg_real, fp.den(F::from(2), &[v[LANE], v[S], zero, v[KL]]));
    out[2] = (-v[HIT], fp.den(F::from(5), &[v[LANE], v[TH], zero, v[KL]]));
    out[3] = (
        -(v[HIT] * v[REL]),
        fp.den(F::from(6), &[v[LANE], v[U], zero, v[KL]]),
    );
    for i in 0..14 {
        out[4 + i] = (F::ONE, fp.den(F::from(9), &[v[LIMB + i]]));
    }
}

pub fn trace_constraints(v: &[F], c: &Consts, out: &mut [F]) {
    use trace::*;
    out[0] = v[REAL] * (v[T] - v[P]) + v[IS_END] * (c.duration - v[P]) - limbs(v, LIMB, 4);
    out[1] = v[IS_FIRST] * v[P];
    out[2] = v[REAL] * v[ACT] * (v[ACT] - F::ONE);
}

/// EVENT, COPY_OUT, COPY_IN, LIMB0..3.
pub fn trace_slots(v: &[F], fp: &Fp, out: &mut [(F, F)]) {
    use trace::*;
    let one = F::ONE;
    out[0] = (
        -v[REAL],
        fp.den(F::from(3) + v[ACT], &[v[LANE], v[T], v[IDX], F::ZERO]),
    );
    out[1] = (v[REAL], fp.den(F::from(8), &[v[IDX] + one, v[T]]));
    out[2] = (
        -((v[REAL] + v[IS_END]) * (one - v[IS_FIRST])),
        fp.den(F::from(8), &[v[IDX], v[P]]),
    );
    for i in 0..4 {
        out[3 + i] = (one, fp.den(F::from(9), &[v[LIMB + i]]));
    }
}

pub fn byte_slots(v: &[F], fp: &Fp, out: &mut [(F, F)]) {
    out[0] = (-v[byte::MU], fp.den(F::from(9), &[v[byte::VAL]]));
}

pub fn slots(kind: Kind, v: &[F], fp: &Fp, out: &mut [(F, F)]) {
    match kind {
        Kind::Lane(l) => lane_slots(v, F::from(l as u64), fp, out),
        Kind::Chart => chart_slots(v, fp, out),
        Kind::Trace => trace_slots(v, fp, out),
        Kind::Byte => byte_slots(v, fp, out),
    }
}

pub fn constraints(kind: Kind, v: &[F], c: &Consts, out: &mut [F]) {
    match kind {
        Kind::Lane(_) => lane_constraints(v, out),
        Kind::Chart => chart_constraints(v, out),
        Kind::Trace => trace_constraints(v, c, out),
        Kind::Byte => {}
    }
}

/// Batching data for the row sumcheck polynomial of one table.
pub struct TableBatch<'a> {
    pub kind: Kind,
    pub fp: Fp,
    pub consts: Consts,
    /// β^{i} for this table's constraints (global counter).
    pub beta: &'a [F],
    /// χ_s(z) for this table's slots.
    pub chi: &'a [F],
    pub lambda: F,
    pub kappa_zeta: [F; 5],
}

/// f_T(x) = eq_r·Σβ^i C_i + eq_z·Σ_s χ_s(p_s + λ q_s) (+ κΣζ^c counts for the chart).
pub fn table_poly(b: &TableBatch, v: &[F], eq_r: F, eq_z: F) -> F {
    let mut cons = [F::ZERO; 25];
    let mut sl = [(F::ZERO, F::ZERO); 18];
    let nc = b.kind.constraints();
    let ns = b.kind.slots();
    constraints(b.kind, v, &b.consts, &mut cons[..nc]);
    slots(b.kind, v, &b.fp, &mut sl[..ns]);
    let mut c_acc = F::ZERO;
    for i in 0..nc {
        c_acc += b.beta[i] * cons[i];
    }
    let mut s_acc = F::ZERO;
    for i in 0..ns {
        s_acc += b.chi[i] * (sl[i].0 + b.lambda * sl[i].1);
    }
    let mut total = eq_r * c_acc + eq_z * s_acc;
    if b.kind == Kind::Chart {
        total += chart_counts(v, &b.kappa_zeta);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poly::interpolate;
    use rand::SeedableRng;

    /// Every table polynomial must have degree ≤ 4 along any line (sumcheck degree bound).
    #[test]
    fn table_polynomials_have_degree_at_most_four() {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(5);
        let beta: Vec<F> = (0..32).map(|_| F::random(&mut rng)).collect();
        let chi: Vec<F> = (0..18).map(|_| F::random(&mut rng)).collect();
        for kind in KINDS {
            let batch = TableBatch {
                kind,
                fp: Fp::new(F::random(&mut rng), F::random(&mut rng)),
                consts: Consts {
                    duration: F::random(&mut rng),
                },
                beta: &beta[..kind.constraints()],
                chi: &chi[..kind.slots()],
                lambda: F::random(&mut rng),
                kappa_zeta: [0; 5].map(|_| F::random(&mut rng)),
            };
            for _ in 0..20 {
                let a: Vec<F> = (0..kind.width() + 2).map(|_| F::random(&mut rng)).collect();
                let b: Vec<F> = (0..kind.width() + 2).map(|_| F::random(&mut rng)).collect();
                let at = |t: u64| {
                    let t = F::from(t);
                    let v: Vec<F> = a.iter().zip(&b).map(|(x, y)| *x + t * y).collect();
                    let w = kind.width();
                    table_poly(&batch, &v[..w], v[w], v[w + 1])
                };
                let evals: Vec<F> = (0..5).map(at).collect();
                for t in 5..8 {
                    assert_eq!(
                        interpolate(&evals, F::from(t)),
                        at(t),
                        "{kind:?} exceeds degree 4"
                    );
                }
            }
        }
    }
}
