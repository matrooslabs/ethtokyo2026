//! Shape-derived layouts shared by prover and verifier (SPEC §7.3–7.5).
use super::relation::{Kind, KINDS};
use crate::field::{Field, F};
use crate::mle::{eq_const, log2_ceil};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shape {
    /// Row bits per table in KINDS order.
    pub bits: [usize; 7],
}

#[derive(Clone, Copy, Debug)]
pub struct SlotPos {
    pub table: usize,
    pub slot: usize,
    pub offset: usize,
    pub bits: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct Block {
    pub table: usize,
    pub offset: usize,
    pub row_bits: usize,
    pub col_log: usize,
}

impl Shape {
    pub fn r_max(&self) -> usize {
        *self.bits.iter().max().unwrap()
    }

    /// Leaf slots sorted by (size desc, table, slot); G = ceil(log2 total), at least 1.
    pub fn leaf_layout(&self) -> (Vec<SlotPos>, usize) {
        let mut slots: Vec<(usize, usize, usize)> = Vec::new();
        for (t, kind) in KINDS.iter().enumerate() {
            for s in 0..kind.slots() {
                slots.push((self.bits[t], t, s));
            }
        }
        slots.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let mut offset = 0;
        let mut out = Vec::with_capacity(slots.len());
        for (bits, table, slot) in slots {
            out.push(SlotPos {
                table,
                slot,
                offset,
                bits,
            });
            offset += 1 << bits;
        }
        (out, log2_ceil(offset).max(1))
    }

    /// ADV blocks sorted by (size desc, table); returns blocks and log2 of total size.
    pub fn adv_layout(&self) -> (Vec<Block>, usize) {
        let mut blocks: Vec<(usize, usize)> = KINDS
            .iter()
            .enumerate()
            .map(|(t, k)| (self.bits[t] + k.col_slots_log(), t))
            .collect();
        blocks.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut offset = 0;
        let mut out = Vec::new();
        for (size_log, table) in blocks {
            let kind = KINDS[table];
            out.push(Block {
                table,
                offset,
                row_bits: self.bits[table],
                col_log: kind.col_slots_log(),
            });
            offset += 1 << size_log;
        }
        (out, log2_ceil(offset))
    }

    /// Number of variables of the opened polynomials.
    pub fn opening_vars(&self) -> usize {
        let (_, adv_bits) = self.adv_layout();
        adv_bits
            .max(2 + self.bits[Kind::Trace.index()])
            .max(3 + self.bits[Kind::Chart.index()])
    }

    pub fn total_constraints(&self) -> usize {
        KINDS.iter().map(|k| k.constraints()).sum()
    }

    /// Starting global constraint index per table.
    pub fn constraint_offsets(&self) -> [usize; 7] {
        let mut out = [0; 7];
        let mut acc = 0;
        for (t, k) in KINDS.iter().enumerate() {
            out[t] = acc;
            acc += k.constraints();
        }
        out
    }

    /// χ_s(z) for every slot, indexed [table][slot].
    pub fn chi(&self, z: &[F]) -> Vec<Vec<F>> {
        let (slots, g) = self.leaf_layout();
        assert_eq!(z.len(), g);
        let mut out: Vec<Vec<F>> = KINDS.iter().map(|k| vec![F::ZERO; k.slots()]).collect();
        for s in slots {
            out[s.table][s.slot] = eq_const((s.offset >> s.bits) as u64, &z[s.bits..]);
        }
        out
    }
}

/// Claims in canonical order: (table, column index within the table's width).
pub fn claim_columns() -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (t, k) in KINDS.iter().enumerate() {
        for c in 0..k.adv() + k.src() {
            out.push((t, c));
        }
    }
    out
}

pub fn one_minus_sum(chi: &[Vec<F>]) -> F {
    F::ONE - chi.iter().flatten().copied().sum::<F>()
}
