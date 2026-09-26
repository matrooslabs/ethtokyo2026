//! Prover (SPEC §7.2).
use super::layout::{claim_columns, Shape};
use super::relation::{self, Consts, Fp, Kind, TableBatch, KINDS};
use super::witness::{trace_rowmajor, Witness};
use super::{absorb_statement, Mode, ScoreProof, Statement, DOMAIN};
use crate::field::{Field, F};
use crate::logup_gkr;
use crate::mle::{eq_table, fold, mle_eval};
use crate::poly::{compress, interpolate};
use crate::transcript::Transcript;
use crate::zeromorph::{self, Srs};
use anyhow::{ensure, Result};
use mania_scoring_core::InputEvent;
use rayon::prelude::*;
use std::time::Instant;

#[derive(Default, Debug, Clone, serde::Serialize)]
pub struct Timings {
    pub witness_ms: f64,
    pub commit_ms: f64,
    pub gkr_ms: f64,
    pub row_sumcheck_ms: f64,
    pub reduction_ms: f64,
    pub opening_ms: f64,
    pub total_ms: f64,
}

pub fn shape_of(w: &Witness) -> Shape {
    let mut bits = [0; 7];
    for (i, t) in w.tables.iter().enumerate() {
        bits[i] = t.bits;
    }
    Shape { bits }
}

pub fn build_adv(w: &Witness, shape: &Shape) -> (Vec<F>, usize) {
    let (blocks, adv_bits) = shape.adv_layout();
    let mut adv = vec![F::ZERO; 1 << adv_bits];
    for b in blocks {
        let t = &w.tables[b.table];
        for c in 0..t.kind.adv() {
            let base = b.offset + (c << b.row_bits);
            adv[base..base + (1 << b.row_bits)].copy_from_slice(&t.cols[c]);
        }
    }
    (adv, adv_bits)
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

pub fn prove(
    w: &Witness,
    st: &Statement,
    srs: &Srs,
    events: &[InputEvent],
) -> Result<(ScoreProof, Timings)> {
    let start = Instant::now();
    let mut timings = Timings::default();
    ensure!(
        st.n as usize == w.n && st.duration == w.duration,
        "statement does not match witness"
    );
    let shape = shape_of(w);
    let lane_bits = w.lane_bits().map(|b| b as u64);

    // 1. Commit advice.
    let t0 = Instant::now();
    let (adv, _) = build_adv(w, &shape);
    let adv_commitment = srs.commit(&adv);
    timings.commit_ms = ms(t0);

    let mut tr = Transcript::new(DOMAIN);
    absorb_statement(&mut tr, st, &lane_bits, &w.counts, &adv_commitment);
    let alpha = tr.squeeze();
    let gamma = tr.squeeze();
    let fp = Fp::new(alpha, gamma);

    // 2. Leaves.
    let t0 = Instant::now();
    let (slots, g) = shape.leaf_layout();
    let mut lp = vec![F::ZERO; 1 << g];
    let mut lq = vec![F::ONE; 1 << g];
    for (ti, table) in w.tables.iter().enumerate() {
        let kind = table.kind;
        let rows = table.rows();
        let per_row: Vec<Vec<(F, F)>> = (0..rows)
            .into_par_iter()
            .map(|r| {
                let mut v = vec![F::ZERO; kind.width()];
                table.row(r, &mut v);
                let mut out = vec![(F::ZERO, F::ZERO); kind.slots()];
                relation::slots(kind, &v, &fp, &mut out);
                out
            })
            .collect();
        for s in slots.iter().filter(|s| s.table == ti) {
            for (r, vals) in per_row.iter().enumerate() {
                lp[s.offset + r] = vals[s.slot].0;
                lq[s.offset + r] = vals[s.slot].1;
            }
        }
    }
    let (gkr, gout) = logup_gkr::prove(lp, lq, &mut tr);
    timings.gkr_ms = ms(t0);

    // 3. Row sumcheck.
    let t0 = Instant::now();
    let lambda = tr.squeeze();
    let beta = tr.squeeze();
    let zeta = tr.squeeze();
    let kappa = tr.squeeze();
    let r_max = shape.r_max();
    let r = tr.squeeze_n(r_max);
    let chi = shape.chi(&gout.point);
    let total_c = shape.total_constraints();
    let mut beta_pows = vec![F::ONE; total_c.max(1)];
    for i in 1..total_c {
        beta_pows[i] = beta_pows[i - 1] * beta;
    }
    let offsets = shape.constraint_offsets();
    let mut kz = [F::ZERO; 5];
    let mut zp = kappa;
    for c in 0..5 {
        kz[c] = zp;
        zp *= zeta;
    }
    let consts = Consts {
        duration: F::from(w.duration),
    };
    let batches: Vec<TableBatch> = KINDS
        .iter()
        .enumerate()
        .map(|(t, &kind)| TableBatch {
            kind,
            fp,
            consts,
            beta: &beta_pows[offsets[t]..offsets[t] + kind.constraints()],
            chi: &chi[t],
            lambda,
            kappa_zeta: kz,
        })
        .collect();

    let full = 1usize << r_max;
    let mut eqr = eq_table(&r);
    // Padded columns (width) + eq_z per table.
    let mut cols: Vec<Vec<Vec<F>>> = w
        .tables
        .iter()
        .map(|t| {
            t.cols
                .iter()
                .map(|c| {
                    let mut v = c.clone();
                    v.resize(full, F::ZERO);
                    v
                })
                .collect()
        })
        .collect();
    let mut eqz: Vec<Vec<F>> = w
        .tables
        .iter()
        .map(|t| {
            let mut v = eq_table(&gout.point[..t.bits]);
            v.resize(full, F::ZERO);
            v
        })
        .collect();
    let mut row_rounds = Vec::with_capacity(r_max);
    let mut r_prime = Vec::with_capacity(r_max);
    for j in 0..r_max {
        let mut evals = [F::ZERO; 5];
        for (t, batch) in batches.iter().enumerate() {
            let nz = 1usize << w.tables[t].bits.saturating_sub(j);
            let pairs = (nz / 2).max(1);
            let width = batch.kind.width();
            let tc = &cols[t];
            let ez = &eqz[t];
            let part = (0..pairs)
                .into_par_iter()
                .fold(
                    || ([F::ZERO; 5], vec![F::ZERO; width], vec![F::ZERO; width]),
                    |(mut acc, mut v, mut d), i| {
                        let (lo, hi) = (2 * i, 2 * i + 1);
                        for c in 0..width {
                            v[c] = tc[c][lo];
                            d[c] = tc[c][hi] - tc[c][lo];
                        }
                        let (mut er, der) = (eqr[lo], eqr[hi] - eqr[lo]);
                        let (mut ezv, dez) = (ez[lo], ez[hi] - ez[lo]);
                        for (step, slot) in acc.iter_mut().enumerate() {
                            if step > 0 {
                                for c in 0..width {
                                    v[c] += d[c];
                                }
                                er += der;
                                ezv += dez;
                            }
                            *slot += relation::table_poly(batch, &v, er, ezv);
                        }
                        (acc, v, d)
                    },
                )
                .map(|x| x.0)
                .reduce(
                    || [F::ZERO; 5],
                    |mut a, b| {
                        for (x, y) in a.iter_mut().zip(b) {
                            *x += y;
                        }
                        a
                    },
                );
            for (e, p) in evals.iter_mut().zip(part) {
                *e += p;
            }
        }
        let sent = compress(&evals);
        tr.absorb(&sent);
        row_rounds.push([sent[0], sent[1], sent[2], sent[3]]);
        let x = tr.squeeze();
        eqr = fold(&eqr, x);
        for t in 0..cols.len() {
            for c in cols[t].iter_mut() {
                *c = fold(c, x);
            }
            eqz[t] = fold(&eqz[t], x);
        }
        r_prime.push(x);
    }
    let claims: Vec<F> = claim_columns()
        .par_iter()
        .map(|&(t, c)| mle_eval(&w.tables[t].cols[c], &r_prime[..w.tables[t].bits]))
        .collect();
    tr.absorb(&claims);
    timings.row_sumcheck_ms = ms(t0);

    // 4. Opening reduction.
    let t0 = Instant::now();
    let mu = tr.squeeze();
    let a_vars = shape.opening_vars();
    let big = 1usize << a_vars;
    let chart_rm = w.chart.rowmajor();
    let trace_rm = trace_rowmajor(events);
    let mut adv_p = adv;
    adv_p.resize(big, F::ZERO);
    let mut ch_p = chart_rm;
    ch_p.resize(big, F::ZERO);
    let mut tr_p = trace_rm;
    tr_p.resize(big, F::ZERO);
    let (blocks, _) = shape.adv_layout();
    let mut w_a = vec![F::ZERO; big];
    let mut w_n = vec![F::ZERO; big];
    let mut w_e = vec![F::ZERO; big];
    let mut mu_pow = F::ONE;
    let mut red_claim = F::ZERO;
    let eq_by_table: Vec<Vec<F>> = w
        .tables
        .iter()
        .map(|t| eq_table(&r_prime[..t.bits]))
        .collect();
    for (i, &(t, c)) in claim_columns().iter().enumerate() {
        let kind = KINDS[t];
        let eq_t = &eq_by_table[t];
        if c < kind.adv() {
            let b = blocks.iter().find(|b| b.table == t).unwrap();
            let base = b.offset + (c << b.row_bits);
            for (row, e) in eq_t.iter().enumerate() {
                w_a[base + row] += mu_pow * e;
            }
        } else {
            let sc = c - kind.adv();
            let (target, width) = match kind {
                Kind::Chart => (&mut w_n, 8),
                Kind::Trace => (&mut w_e, 4),
                _ => unreachable!(),
            };
            for (row, e) in eq_t.iter().enumerate() {
                target[width * row + sc] += mu_pow * e;
            }
        }
        red_claim += mu_pow * claims[i];
        mu_pow *= mu;
    }
    let mut polys = [adv_p.clone(), ch_p.clone(), tr_p.clone()];
    let mut weights = [w_a, w_n, w_e];
    let mut red_rounds = Vec::with_capacity(a_vars);
    let mut z_star = Vec::with_capacity(a_vars);
    for _ in 0..a_vars {
        let half = polys[0].len() / 2;
        let evals = (0..half)
            .into_par_iter()
            .fold(
                || [F::ZERO; 3],
                |mut acc, i| {
                    for k in 0..3 {
                        let (p0, p1) = (polys[k][2 * i], polys[k][2 * i + 1]);
                        let (w0, w1) = (weights[k][2 * i], weights[k][2 * i + 1]);
                        acc[0] += p0 * w0;
                        acc[1] += p1 * w1;
                        acc[2] += (p1.double() - p0) * (w1.double() - w0);
                    }
                    acc
                },
            )
            .reduce(
                || [F::ZERO; 3],
                |a, b| [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
            );
        debug_assert_eq!(evals[0] + evals[1], red_claim);
        let sent = compress(&evals);
        tr.absorb(&sent);
        red_rounds.push([sent[0], sent[1]]);
        let x = tr.squeeze();
        red_claim = interpolate(&evals, x);
        for k in 0..3 {
            polys[k] = fold(&polys[k], x);
            weights[k] = fold(&weights[k], x);
        }
        z_star.push(x);
    }
    let adv_eval = polys[0][0];
    let chart_eval = polys[1][0];
    let trace_val = polys[2][0];
    let trace_eval = (st.mode == Mode::Committed).then_some(trace_val);
    let mut finals = vec![adv_eval, chart_eval];
    finals.extend(trace_eval);
    tr.absorb(&finals);
    timings.reduction_ms = ms(t0);

    // 5. Batched Zeromorph opening.
    let t0 = Instant::now();
    let nu = tr.squeeze();
    let nu2 = nu * nu;
    let committed = st.mode == Mode::Committed;
    let f: Vec<F> = adv_p
        .par_iter()
        .zip(ch_p.par_iter())
        .zip(tr_p.par_iter())
        .map(|((a, c), t)| {
            if committed {
                *a + nu * c + nu2 * t
            } else {
                *a + nu * c
            }
        })
        .collect();
    let zm = zeromorph::open(srs, &f, &z_star, &mut tr);
    timings.opening_ms = ms(t0);
    timings.total_ms = ms(start);

    Ok((
        ScoreProof {
            lane_bits,
            counts: w.counts,
            adv_commitment,
            gkr,
            row_rounds,
            claims,
            red_rounds,
            adv_eval,
            chart_eval,
            trace_eval,
            zm,
        },
        timings,
    ))
}
