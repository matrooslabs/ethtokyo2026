//! Witness generation: builds all tables (SPEC §5) from a V1 play input.
use super::relation::{
    self, chart as ch, lane as ln, trace as tr, Kind, HEAD_HI, HEAD_LO, KINDS, S16, TAIL_HI,
    TAIL_LO, W,
};
use crate::field::{batch_invert, Field, PrimeField, F};
use crate::mle::log2_ceil;
use anyhow::{bail, ensure, Result};
use mania_scoring_core::{
    chart_hash, evaluate, input_policy_hash, ruleset_id, trace_root, Chart, InputEvent, PlayInput,
    PublicValues, SessionFooter, SessionHeader,
};

/// One table: `cols[c][row]`, width = adv + src + public, each column of length 2^bits.
#[derive(Clone)]
pub struct Table {
    pub kind: Kind,
    pub bits: usize,
    pub cols: Vec<Vec<F>>,
}

impl Table {
    fn new(kind: Kind, bits: usize) -> Self {
        Table {
            kind,
            bits,
            cols: vec![vec![F::ZERO; 1 << bits]; kind.width()],
        }
    }
    pub fn rows(&self) -> usize {
        1 << self.bits
    }
    pub fn row(&self, r: usize, out: &mut [F]) {
        for (c, col) in self.cols.iter().enumerate() {
            out[c] = col[r];
        }
    }
}

/// Organizer-side chart data (registered once; SPEC §8.1).
#[derive(Clone, Debug)]
pub struct ChartData {
    pub m: usize,
    pub bits: usize,
    pub lane: Vec<u64>,
    pub s: Vec<u64>,
    pub e: Vec<u64>,
    pub hold: Vec<u64>,
    pub kl: Vec<u64>,
    pub components: u64,
    pub max_end: u64,
}

impl ChartData {
    pub fn from_chart(chart: &Chart) -> Result<Self> {
        mania_scoring_core::validate_chart(chart).map_err(anyhow::Error::msg)?;
        let m = chart.notes.len();
        let mut counters = [0u64; 4];
        let mut d = ChartData {
            m,
            bits: log2_ceil(m),
            lane: vec![],
            s: vec![],
            e: vec![],
            hold: vec![],
            kl: vec![],
            components: 0,
            max_end: 0,
        };
        for n in &chart.notes {
            let hold = (n.end_us > n.start_us) as u64;
            d.lane.push(n.lane as u64);
            d.s.push(n.start_us);
            d.e.push(n.end_us);
            d.hold.push(hold);
            d.kl.push(counters[n.lane as usize]);
            counters[n.lane as usize] += 1;
            d.components += 1 + hold;
            d.max_end = d.max_end.max(n.end_us);
        }
        Ok(d)
    }

    /// Row-major CHART vector: index 8k + c, c = lane, s, e, hold, kl.
    pub fn rowmajor(&self) -> Vec<F> {
        let mut v = vec![F::ZERO; 8 << self.bits];
        for k in 0..self.m {
            v[8 * k] = F::from(self.lane[k]);
            v[8 * k + 1] = F::from(self.s[k]);
            v[8 * k + 2] = F::from(self.e[k]);
            v[8 * k + 3] = F::from(self.hold[k]);
            v[8 * k + 4] = F::from(self.kl[k]);
        }
        v
    }
}

/// Row-major TRACE vector (device commitment, SPEC §7.3): index 4j + c, c = t, lane, act.
pub fn trace_rowmajor(events: &[InputEvent]) -> Vec<F> {
    let mut v = vec![F::ZERO; 4 * events.len()];
    for (j, e) in events.iter().enumerate() {
        v[4 * j] = F::from(e.timestamp_us);
        v[4 * j + 1] = F::from(e.lane as u64);
        v[4 * j + 2] = F::from(e.action as u64);
    }
    v
}

#[derive(Clone)]
pub struct Witness {
    pub tables: Vec<Table>,
    pub counts: [u64; 5],
    pub reference: PublicValues,
    pub chart: ChartData,
    pub n: usize,
    pub duration: u64,
}

impl Witness {
    pub fn table(&self, kind: Kind) -> &Table {
        &self.tables[kind.index()]
    }
    pub fn lane_bits(&self) -> [usize; 4] {
        [0, 1, 2, 3].map(|l| self.tables[l].bits)
    }
}

fn set_limbs(col: &mut [Vec<F>], start: usize, row: usize, mut x: u64, count: usize) {
    for i in 0..count {
        col[start + i][row] = F::from(x & 0xff);
        x >>= 8;
    }
    assert_eq!(x, 0, "value does not fit its limbs");
}

fn fill_lane_public(t: &mut Table) {
    let n = t.rows();
    for r in 0..n {
        t.cols[ln::IS_FIRST][r] = F::from((r == 0) as u64);
        t.cols[ln::IS_LAST][r] = F::from((r == n - 1) as u64);
        t.cols[ln::ID][r] = F::from(r as u64);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum RowType {
    Open,
    Close,
    Down,
    Up,
}

/// Reference result from `core::evaluate` on a self-consistent input (the header is
/// irrelevant to scoring; session binding is checked by the verifier/contract).
pub fn reference(chart: &Chart, events: &[InputEvent], duration: u64) -> Result<PublicValues> {
    let header = SessionHeader {
        chain_id: 0,
        verifier: [0; 20],
        match_id: [0; 32],
        session_id: [0; 32],
        challenge: [0; 32],
        player: [0; 20],
        device: [0; 20],
        chart_hash: chart_hash(chart),
        ruleset_id: ruleset_id(),
        bitstream_hash: [0; 32],
        input_policy_hash: input_policy_hash(),
    };
    let footer = SessionFooter {
        event_count: events.len() as u32,
        duration_us: duration,
        trace_root: trace_root(&header.session_id, events),
    };
    let input = PlayInput {
        header,
        footer,
        chart: chart.clone(),
        events: events.to_vec(),
    };
    evaluate(&input).map_err(anyhow::Error::msg)
}

pub fn build_from_input(input: &PlayInput) -> Result<Witness> {
    ensure!(
        input.events.len() == input.footer.event_count as usize,
        "event count mismatch"
    );
    build(&input.chart, &input.events, input.footer.duration_us)
}

pub fn build(chart_in: &Chart, events: &[InputEvent], duration: u64) -> Result<Witness> {
    let reference = reference(chart_in, events, duration)?;
    let chart = ChartData::from_chart(chart_in)?;
    let n = events.len();

    // Global note index by (lane, kl).
    let mut by_lane: [Vec<usize>; 4] = Default::default();
    for k in 0..chart.m {
        by_lane[chart.lane[k] as usize].push(k);
    }
    let mut hit: Vec<Option<u64>> = vec![None; chart.m];
    let mut rel: Vec<Option<u64>> = vec![None; chart.m];
    let mut tables: Vec<Table> = Vec::with_capacity(7);

    for lane_id in 0..4usize {
        // (sort key, type, v, q, kl)
        let mut rows: Vec<(u128, RowType, u64, u64, u64)> = Vec::new();
        for (kl, &k) in by_lane[lane_id].iter().enumerate() {
            let s = chart.s[k];
            rows.push((
                (4 * s as u128) * S16 as u128,
                RowType::Open,
                s,
                0,
                kl as u64,
            ));
            rows.push((
                ((4 * s + 8 * W + 2) as u128) * S16 as u128,
                RowType::Close,
                s,
                0,
                kl as u64,
            ));
        }
        for (j, e) in events.iter().enumerate() {
            if e.lane as usize == lane_id {
                let key = ((4 * e.timestamp_us + 4 * W + 1) as u128) * S16 as u128 + j as u128;
                let ty = if e.action == 0 {
                    RowType::Down
                } else {
                    RowType::Up
                };
                rows.push((key, ty, e.timestamp_us, j as u64, 0));
            }
        }
        rows.sort_by_key(|r| r.0);
        let bits = log2_ceil(rows.len());
        ensure!(bits <= relation::MAX_LANE_BITS, "lane timeline too large");
        let mut t = Table::new(Kind::Lane(lane_id as u8), bits);
        let (mut o, mut f, mut h, mut a, mut kx, mut last_k) =
            (0u64, 0u64, 0u64, 0u64, 0u64, 0u128);
        let mut inv_rows: Vec<(usize, F)> = Vec::new();
        for (r, &(key, ty, v, q, kl)) in rows.iter().enumerate() {
            let c = &mut t.cols;
            c[ln::O][r] = F::from(o);
            c[ln::F][r] = F::from(f);
            c[ln::H][r] = F::from(h);
            c[ln::A][r] = F::from(a);
            c[ln::KX][r] = F::from(kx);
            c[ln::LAST_K][r] = F::from_u128(last_k);
            c[ln::V][r] = F::from(v);
            c[ln::Q][r] = F::from(q);
            c[ln::KL][r] = F::from(kl);
            set_limbs(c, ln::LIMB, r, (key - last_k) as u64, 7);
            last_k = key;
            match ty {
                RowType::Open => {
                    c[ln::IS_O][r] = F::ONE;
                    ensure!(kl == o, "chart lane-local order mismatch");
                    o += 1;
                }
                RowType::Close => {
                    c[ln::IS_C][r] = F::ONE;
                    if f == kl {
                        c[ln::CC][r] = F::ONE;
                        f += 1;
                    } else {
                        ensure!(f > kl, "front invariant violated");
                        inv_rows.push((r, F::from(f - kl)));
                    }
                }
                RowType::Down => {
                    c[ln::IS_D][r] = F::ONE;
                    ensure!(h == 0, "duplicate DOWN");
                    h = 1;
                    if f < o {
                        c[ln::MD][r] = F::ONE;
                        inv_rows.push((r, F::from(o - f)));
                        hit[by_lane[lane_id][f as usize]] = Some(v);
                        a = 1;
                        kx = f;
                        f += 1;
                    } else {
                        a = 0;
                        kx = 0;
                    }
                }
                RowType::Up => {
                    c[ln::IS_U][r] = F::ONE;
                    ensure!(h == 1, "unmatched UP");
                    h = 0;
                    if a == 1 {
                        rel[by_lane[lane_id][kx as usize]] = Some(v);
                    }
                    a = 0;
                    kx = 0;
                }
            }
        }
        // Padding rows carry the final state unchanged.
        for r in rows.len()..t.rows() {
            let c = &mut t.cols;
            c[ln::O][r] = F::from(o);
            c[ln::F][r] = F::from(f);
            c[ln::H][r] = F::from(h);
            c[ln::A][r] = F::from(a);
            c[ln::KX][r] = F::from(kx);
            c[ln::LAST_K][r] = F::from_u128(last_k);
        }
        let mut invs: Vec<F> = inv_rows.iter().map(|x| x.1).collect();
        batch_invert(&mut invs);
        for ((r, _), inv) in inv_rows.iter().zip(invs) {
            t.cols[ln::INV][*r] = inv;
        }
        fill_lane_public(&mut t);
        tables.push(t);
    }

    // Chart table.
    let mut ct = Table::new(Kind::Chart, chart.bits);
    let mut counts = [0u64; 5];
    for k in 0..chart.m {
        let c = &mut ct.cols;
        let (s, e, hold) = (chart.s[k], chart.e[k], chart.hold[k]);
        c[ch::LANE][k] = F::from(chart.lane[k]);
        c[ch::S][k] = F::from(s);
        c[ch::E][k] = F::from(e);
        c[ch::HOLD][k] = F::from(hold);
        c[ch::KL][k] = F::from(chart.kl[k]);
        c[ch::REAL][k] = F::ONE;
        let is_hit = hit[k].is_some();
        let released = is_hit && rel[k].is_some();
        c[ch::HIT][k] = F::from(is_hit as u64);
        c[ch::REL][k] = F::from(released as u64);
        c[ch::HH][k] = F::from(is_hit as u64 * hold);
        // Head.
        let th = hit[k].unwrap_or(s);
        c[ch::TH][k] = F::from(th);
        if let Some(t) = hit[k] {
            let (sign, delta) = if t >= s { (1, t - s) } else { (0, s - t) };
            let class = HEAD_HI
                .iter()
                .position(|&w| delta <= w)
                .expect("hit outside window");
            c[ch::SIGMA][k] = F::from(sign);
            c[ch::H0 + class][k] = F::ONE;
            counts[class] += 1;
            set_limbs(c, ch::LIMB, k, delta - HEAD_LO[class], 3);
            set_limbs(c, ch::LIMB + 3, k, HEAD_HI[class] - delta, 3);
        }
        // Tail (and release time, bound for any released hit including taps).
        let u = match (rel[k], hold == 1 && is_hit) {
            (Some(u), _) if is_hit => u,
            (_, true) => e + TAIL_LO[5], // unreleased hold: any MISS-range value
            _ => e,
        };
        c[ch::U][k] = F::from(u);
        if hold == 1 && is_hit {
            let (sign, delta) = if u >= e { (1, u - e) } else { (0, e - u) };
            let class = if released {
                TAIL_HI.iter().position(|&w| delta <= w).unwrap()
            } else {
                5
            };
            c[ch::TAU][k] = F::from(sign);
            c[ch::G0 + class][k] = F::ONE;
            if class < 5 {
                counts[class] += 1;
            }
            set_limbs(c, ch::LIMB + 6, k, delta - TAIL_LO[class], 4);
            set_limbs(c, ch::LIMB + 10, k, TAIL_HI[class] - delta, 4);
        }
    }
    tables.push(ct);

    // Trace table (R_E = ceil(log2(n+1)) so row n exists).
    let tbits = log2_ceil(n + 1);
    let mut tt = Table::new(Kind::Trace, tbits);
    for r in 0..tt.rows() {
        let c = &mut tt.cols;
        c[tr::IDX][r] = F::from(r as u64);
        c[tr::IS_FIRST][r] = F::from((r == 0) as u64);
        if r < n {
            let e = &events[r];
            c[tr::T][r] = F::from(e.timestamp_us);
            c[tr::LANE][r] = F::from(e.lane as u64);
            c[tr::ACT][r] = F::from(e.action as u64);
            c[tr::REAL][r] = F::ONE;
        }
        let prev = if r == 0 {
            0
        } else if r <= n {
            events[r - 1].timestamp_us
        } else {
            0
        };
        c[tr::P][r] = F::from(prev);
        let x = if r < n {
            events[r]
                .timestamp_us
                .checked_sub(prev)
                .ok_or_else(|| anyhow::anyhow!("time decreases"))?
        } else if r == n {
            c[tr::IS_END][r] = F::ONE;
            duration
                .checked_sub(prev)
                .ok_or_else(|| anyhow::anyhow!("event after duration"))?
        } else {
            0
        };
        set_limbs(c, tr::LIMB, r, x, 4);
    }
    tables.push(tt);

    // Byte table multiplicities over every limb slot of every table row.
    let mut bt = Table::new(Kind::Byte, relation::byte::BITS);
    let mut mu = [0u64; 256];
    let limb_ranges: [(usize, usize); 3] = [(ln::LIMB, 7), (ch::LIMB, 14), (tr::LIMB, 4)];
    for t in &tables {
        let (start, count) = match t.kind {
            Kind::Lane(_) => limb_ranges[0],
            Kind::Chart => limb_ranges[1],
            Kind::Trace => limb_ranges[2],
            Kind::Byte => unreachable!(),
        };
        for c in start..start + count {
            for x in &t.cols[c] {
                let b = crate::field::fe_to_u64(x).expect("limb");
                mu[b as usize] += 1;
            }
        }
    }
    for b in 0..256 {
        bt.cols[relation::byte::MU][b] = F::from(mu[b]);
        bt.cols[relation::byte::VAL][b] = F::from(b as u64);
    }
    tables.push(bt);
    debug_assert!(tables.iter().zip(KINDS).all(|(t, k)| t.kind == k));

    if counts[..]
        != reference.judgements[..5]
            .iter()
            .map(|&x| x as u64)
            .collect::<Vec<_>>()[..]
    {
        bail!("internal error: timeline counts differ from core::evaluate");
    }
    Ok(Witness {
        tables,
        counts,
        reference,
        chart,
        n,
        duration,
    })
}

/// Debug aid: evaluates every constraint on every row and the logUp balance per
/// fingerprint class. Returns human-readable violations (empty = satisfied).
pub fn check(w: &Witness) -> Vec<String> {
    use crate::field::Field;
    use relation::{Consts, Fp};
    let mut out = Vec::new();
    let consts = Consts {
        duration: F::from(w.duration),
    };
    let fp = Fp::new(F::from(0x1234567u64), F::from(0x9876543210u64));
    let mut total = F::ZERO;
    let mut per_slot: Vec<(Kind, usize, F)> = Vec::new();
    for t in &w.tables {
        let mut v = vec![F::ZERO; t.kind.width()];
        let mut cons = vec![F::ZERO; t.kind.constraints()];
        let mut sl = vec![(F::ZERO, F::ZERO); t.kind.slots()];
        let mut slot_sum = vec![F::ZERO; t.kind.slots()];
        for r in 0..t.rows() {
            t.row(r, &mut v);
            relation::constraints(t.kind, &v, &consts, &mut cons);
            for (i, c) in cons.iter().enumerate() {
                if !bool::from(c.is_zero()) {
                    out.push(format!(
                        "{:?} row {r}: constraint {} = {:?}",
                        t.kind,
                        i + 1,
                        c
                    ));
                }
            }
            relation::slots(t.kind, &v, &fp, &mut sl);
            for (i, (p, q)) in sl.iter().enumerate() {
                let x = *p * q.invert().unwrap();
                slot_sum[i] += x;
                total += x;
            }
        }
        for (i, s) in slot_sum.into_iter().enumerate() {
            per_slot.push((t.kind, i, s));
        }
    }
    if !bool::from(total.is_zero()) {
        out.push(format!("logUp imbalance; per-slot sums: {per_slot:?}"));
    }
    out
}
