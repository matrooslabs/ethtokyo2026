/// OSUMANIA_GKR_SUI_V1 score-proof verifier (SPEC §7.2; engine `scoring::verifier`).
/// Stateless: session/device/chart binding lives in `registry`.
module mania_gkr::verifier;

use mania_gkr::fr::{Self, one, zero};
use mania_gkr::gkr;
use mania_gkr::mle::{Self, eq_const, eq_range, pad_factor};
use mania_gkr::reader::{Self, Reader};
use mania_gkr::relation;
use mania_gkr::transcript::{Self, Transcript};
use mania_gkr::zeromorph::{Self, VerifierKey};
use sui::bls12381::{Self, Scalar};
use sui::group_ops::Element;

use fun fr::add as Element.add;
use fun fr::sub as Element.sub;
use fun fr::mul as Element.mul;

const DOMAIN: vector<u8> = b"OSUMANIA_GKR_SUI_V1";
const MODE_CALLDATA: u8 = 1;
const MODE_COMMITTED: u8 = 2;
const MAX_EVENTS: u64 = 50_000;
const MAX_NOTES: u64 = 10_000;
const MAX_DURATION_US: u64 = 1_800_000_000;
const MAX_LANE_BITS: u64 = 17;
const W: u64 = 136_500;
const BYTE_BITS: u64 = 8;

const EStatement: u64 = 1;
const ECounts: u64 = 2;
const ESrsSize: u64 = 3;
const ERowSumcheck: u64 = 4;
const EReduction: u64 = 5;
const ETrace: u64 = 6;
const EMode: u64 = 7;

/// On-chain chart record created by chart registration (SPEC §8.1).
public struct ChartRecord has copy, drop, store {
    commitment: vector<u8>,
    m: u64,
    bits: u64,
    components: u64,
    max_end: u64,
}

public(package) fun new_chart_record(
    commitment: vector<u8>,
    m: u64,
    bits: u64,
    components: u64,
    max_end: u64,
): ChartRecord {
    ChartRecord { commitment, m, bits, components, max_end }
}

public fun chart_m(c: &ChartRecord): u64 { c.m }

public fun chart_bits(c: &ChartRecord): u64 { c.bits }

public fun chart_components(c: &ChartRecord): u64 { c.components }

public fun chart_max_end(c: &ChartRecord): u64 { c.max_end }

public fun chart_commitment(c: &ChartRecord): vector<u8> { c.commitment }

public struct Statement has drop {
    mode: u8,
    session_digest: vector<u8>,
    n: u64,
    duration: u64,
    chart: ChartRecord,
    /// 48-byte device commitment (mode B); empty in mode A.
    trace_commitment: vector<u8>,
    lane_bits: vector<u64>,
    counts: vector<u64>,
}

public(package) fun new_statement(
    mode: u8,
    session_digest: vector<u8>,
    n: u64,
    duration: u64,
    chart: ChartRecord,
    trace_commitment: vector<u8>,
    lane_bits: vector<u64>,
    counts: vector<u64>,
): Statement {
    Statement { mode, session_digest, n, duration, chart, trace_commitment, lane_bits, counts }
}

public struct VerifiedScore has copy, drop {
    score: u64,
    achieved_points: u64,
    maximum_points: u64,
    /// PERFECT, GREAT, GOOD, OK, MEH, MISS
    judgements: vector<u64>,
}

public fun score(v: &VerifiedScore): u64 { v.score }

public fun achieved_points(v: &VerifiedScore): u64 { v.achieved_points }

public fun maximum_points(v: &VerifiedScore): u64 { v.maximum_points }

public fun judgements(v: &VerifiedScore): vector<u64> { v.judgements }

// ---------------------------------------------------------------- shape (SPEC §7.3–7.5)

fun max_of(v: &vector<u64>): u64 {
    let mut m = 0;
    v.do_ref!(|x| if (*x > m) m = *x);
    m
}

/// Leaf slots sorted by (size desc, table, slot): offsets[t][s] and G.
fun leaf_layout(bits: &vector<u64>): (vector<vector<u64>>, u64) {
    let mut offsets = vector::tabulate!(7, |t| vector::tabulate!(relation::slots(t), |_| 0u64));
    let mut offset = 0;
    let mut b = max_of(bits) + 1;
    while (b > 0) {
        b = b - 1;
        let mut t = 0;
        while (t < 7) {
            if (bits[t] == b) {
                let mut s = 0;
                while (s < relation::slots(t)) {
                    *&mut offsets[t][s] = offset;
                    offset = offset + (1 << (b as u8));
                    s = s + 1;
                };
            };
            t = t + 1;
        };
    };
    let g = mle::log2_ceil(offset);
    (offsets, if (g == 0) 1 else g)
}

/// ADV blocks sorted by (size desc, table): block offset per table and log2 of the total.
fun adv_layout(bits: &vector<u64>): (vector<u64>, u64) {
    let sizes = vector::tabulate!(7, |t| bits[t] + relation::col_slots_log(t));
    let mut offsets = vector::tabulate!(7, |_| 0u64);
    let mut offset = 0;
    let mut sl = max_of(&sizes) + 1;
    while (sl > 0) {
        sl = sl - 1;
        let mut t = 0;
        while (t < 7) {
            if (sizes[t] == sl) {
                *&mut offsets[t] = offset;
                offset = offset + (1 << (sl as u8));
            };
            t = t + 1;
        };
    };
    (offsets, mle::log2_ceil(offset))
}

fun public_values(t: u64, y: &vector<Element<Scalar>>, bits: u64, st: &Statement): vector<Element<Scalar>> {
    if (t < 4) {
        vector[fr::prod_one_minus(y, 0, bits), fr::prod(y, 0, bits), mle::id_mle(y, bits)]
    } else if (t == 4) {
        vector[mle::step_mle(st.chart.m, y, bits)]
    } else if (t == 5) {
        vector[
            mle::step_mle(st.n, y, bits),
            eq_const(st.n, y, 0, bits),
            fr::prod_one_minus(y, 0, bits),
            mle::id_mle(y, bits),
        ]
    } else {
        vector[mle::id_mle(y, bits)]
    }
}

/// Statement items, in the order of SPEC §7.1 (32-byte words, then 48-byte points).
fun statement_items(st: &Statement, vk: &VerifierKey, adv: vector<u8>): vector<vector<u8>> {
    let mut b = vector[
        fr::word_u64(1),
        fr::word_u64(st.mode as u64),
        st.session_digest,
        fr::word_u64(st.n),
        fr::word_u64(st.duration),
        fr::word_u64(st.chart.m),
        fr::word_u64(st.chart.bits),
        fr::word_u64(st.chart.components),
    ];
    st.lane_bits.do_ref!(|x| b.push_back(fr::word_u64(*x)));
    st.counts.do_ref!(|x| b.push_back(fr::word_u64(*x)));
    b.push_back(zeromorph::id(vk));
    b.push_back(st.chart.commitment);
    if (st.mode == MODE_COMMITTED) b.push_back(st.trace_commitment);
    b.push_back(adv);
    b
}

/// Sumcheck rounds of degree d = sent.len(): returns the final claim and the point.
fun sumcheck(
    r: &mut Reader,
    tr: &mut Transcript,
    lag: &mle::Lagrange,
    mut claim: Element<Scalar>,
    rounds: u64,
    per_round: u64,
): (Element<Scalar>, vector<Element<Scalar>>) {
    let mut point = vector[];
    let mut i = 0;
    while (i < rounds) {
        let sent = reader::scalars(r, per_round);
        transcript::absorb_scalars(tr, &sent);
        let evals = mle::decompress(&claim, &sent);
        let x = transcript::squeeze(tr);
        claim = mle::interpolate(lag, &evals, &x);
        point.push_back(x);
        i = i + 1;
    };
    (claim, point)
}

/// Mode A: TRACE(z*) = Σ_j eq(j, z*_{≥2})·(t_j e_0 + lane_j e_1 + act_j e_2), from the trace
/// staged on-chain: `t[j]` is the timestamp as a scalar, `la[j] = lane | act << 2`.
/// Sums run per 1024-row block with the low eq table; the high factor is applied per block.
public(package) fun trace_eval_calldata(
    t: &vector<Element<Scalar>>,
    la: &vector<u8>,
    n: u64,
    re: u64,
    z: &vector<Element<Scalar>>,
): Element<Scalar> {
    assert!(t.length() == n && la.length() == n, ETrace);
    let low_bits = if (re < 10) re else 10;
    let low = mle::eq_table(z, 2, low_bits);
    let block = 1u64 << (low_bits as u8);
    let (mut s_t, mut s_act) = (zero(), zero());
    let mut s_lane = vector[zero(), zero(), zero(), zero()];
    let mut start = 0;
    while (start < n) {
        let end = if (n - start < block) n else start + block;
        let (mut bt, mut ba) = (zero(), zero());
        let mut bl = vector[zero(), zero(), zero(), zero()];
        let mut j = start;
        while (j < end) {
            let w = &low[j - start];
            bt = bt.add(&w.mul(&t[j]));
            let code = la[j];
            let lane = (code & 3) as u64;
            *&mut bl[lane] = bl[lane].add(w);
            if (code >= 4) ba = ba.add(w);
            j = j + 1;
        };
        let high = eq_const(start >> (low_bits as u8), z, 2 + low_bits, re - low_bits);
        s_t = s_t.add(&high.mul(&bt));
        s_act = s_act.add(&high.mul(&ba));
        let mut l = 1;
        while (l < 4) {
            *&mut s_lane[l] = s_lane[l].add(&high.mul(&bl[l]));
            l = l + 1;
        };
        start = end;
    };
    let e0 = eq_const(0, z, 0, 2);
    let e1 = eq_const(1, z, 0, 2);
    let e2 = eq_const(2, z, 0, 2);
    // Σ lane·B_lane
    let lanes = s_lane[1].add(&s_lane[2]).add(&s_lane[2]).add(&s_lane[3]).add(&s_lane[3]).add(&s_lane[3]);
    e0.mul(&s_t).add(&e1.mul(&lanes)).add(&e2.mul(&s_act)).mul(&pad_factor(z, 2 + re))
}

/// Verifies a score proof given as item groups. Mode A passes the staged trace (`t`, `la`,
/// see `trace_eval_calldata`); mode B passes empty vectors.
public fun verify(
    vk: &VerifierKey,
    st: &Statement,
    proof: vector<vector<vector<u8>>>,
    trace_t: &vector<Element<Scalar>>,
    trace_la: &vector<u8>,
): VerifiedScore {
    // Native statement checks (SPEC §4).
    assert!(st.mode == MODE_CALLDATA || st.mode == MODE_COMMITTED, EMode);
    assert!(st.n <= MAX_EVENTS, EStatement);
    assert!(st.chart.m >= 1 && st.chart.m <= MAX_NOTES, EStatement);
    assert!(st.chart.bits == mle::log2_ceil(st.chart.m), EStatement);
    assert!(st.duration <= MAX_DURATION_US && st.duration >= st.chart.max_end + W, EStatement);
    assert!(st.lane_bits.length() == 4 && st.counts.length() == 5, EStatement);
    st.lane_bits.do_ref!(|b| assert!(*b <= MAX_LANE_BITS, EStatement));
    assert!(
        (st.mode == MODE_COMMITTED) == (st.trace_commitment.length() == 48) &&
        (st.mode == MODE_COMMITTED || st.trace_commitment.is_empty()),
        EStatement,
    );
    let c = &st.counts;
    let hits = c[0] + c[1] + c[2] + c[3] + c[4];
    let components = st.chart.components;
    assert!(components > 0 && hits <= components, ECounts);
    let achieved = 320 * c[0] + 300 * c[1] + 200 * c[2] + 100 * c[3] + 50 * c[4];
    let maximum = 320 * components;

    let mut bits = st.lane_bits;
    bits.append(vector[st.chart.bits, mle::log2_ceil(st.n + 1), BYTE_BITS]);
    let (blk_off, adv_bits) = adv_layout(&bits);
    let mut a_vars = adv_bits;
    if (2 + bits[5] > a_vars) a_vars = 2 + bits[5];
    if (3 + bits[4] > a_vars) a_vars = 3 + bits[4];
    assert!(a_vars <= zeromorph::smax(vk), ESrsSize);

    let lag = mle::lagrange();
    let mut r = reader::new(proof);
    let (adv_c, adv_b) = reader::g1(&mut r);
    let mut tr = transcript::new(DOMAIN);
    transcript::absorb(&mut tr, statement_items(st, vk, adv_b));
    let alpha = transcript::squeeze(&mut tr);
    let gamma = transcript::squeeze(&mut tr);

    // GKR over the leaves.
    let (slot_off, g) = leaf_layout(&bits);
    let gout = gkr::verify(&mut r, g, &mut tr, &lag);
    let z = gkr::point(&gout);

    // Row sumcheck.
    let lambda = transcript::squeeze(&mut tr);
    let beta = transcript::squeeze(&mut tr);
    let zeta = transcript::squeeze(&mut tr);
    let kappa = transcript::squeeze(&mut tr);
    let r_max = max_of(&bits);
    let rv = transcript::squeeze_n(&mut tr, r_max);
    let mut chi = vector[];
    let mut chi_sum = zero();
    let mut t = 0;
    while (t < 7) {
        let b = bits[t];
        let row = vector::tabulate!(relation::slots(t), |s| {
            let x = eq_const(slot_off[t][s] >> (b as u8), z, b, g - b);
            chi_sum = chi_sum.add(&x);
            x
        });
        chi.push_back(row);
        t = t + 1;
    };
    let mut kz = vector[];
    let mut zp = kappa;
    let mut count_claim = zero();
    let mut k = 0;
    while (k < 5) {
        count_claim = count_claim.add(&zp.mul(&fr::from_u64(c[k])));
        kz.push_back(zp);
        zp = zp.mul(&zeta);
        k = k + 1;
    };
    let claim0 = gkr::p(&gout)
        .add(&lambda.mul(&gkr::q(&gout).sub(&fr::one_minus(&chi_sum))))
        .add(&count_claim);
    let (claim, rp) = sumcheck(&mut r, &mut tr, &lag, claim0, r_max, 4);
    let mut n_claims = 0;
    t = 0;
    while (t < 7) {
        n_claims = n_claims + relation::adv(t) + relation::src(t);
        t = t + 1;
    };
    let claims = reader::scalars(&mut r, n_claims);
    transcript::absorb_scalars(&mut tr, &claims);

    // Recompute F(r').
    let mut total_c = 0;
    t = 0;
    while (t < 7) {
        total_c = total_c + relation::constraints(t);
        t = t + 1;
    };
    let mut beta_pows = vector[one()];
    let mut i = 1;
    while (i < total_c) {
        let p = beta_pows[i - 1].mul(&beta);
        beta_pows.push_back(p);
        i = i + 1;
    };
    let batch = relation::new_batch(relation::new_fp(alpha, gamma), st.duration, beta_pows, chi, lambda, kz);
    let eq_r = eq_range(&rv, 0, &rp, 0, r_max);
    let mut expected = zero();
    let mut cursor = 0;
    let mut beta_off = 0;
    t = 0;
    while (t < 7) {
        let b = bits[t];
        let pad = pad_factor(&rp, b);
        let nc = relation::adv(t) + relation::src(t);
        let mut v = vector[];
        i = 0;
        while (i < nc) {
            v.push_back(claims[cursor + i].mul(&pad));
            i = i + 1;
        };
        cursor = cursor + nc;
        public_values(t, &rp, b, st).do!(|p| v.push_back(p.mul(&pad)));
        let eq_z = eq_range(z, 0, &rp, 0, b).mul(&pad);
        expected = expected.add(&relation::table_poly(&batch, t, &v, &eq_r, &eq_z, beta_off));
        beta_off = beta_off + relation::constraints(t);
        t = t + 1;
    };
    assert!(fr::eq(&claim, &expected), ERowSumcheck);

    // Opening reduction.
    let mu = transcript::squeeze(&mut tr);
    let mut mu_pows = vector[];
    let mut red0 = zero();
    let mut mp = one();
    claims.do_ref!(|cl| {
        red0 = red0.add(&mp.mul(cl));
        mu_pows.push_back(mp);
        mp = mp.mul(&mu);
    });
    let (red_claim, zs) = sumcheck(&mut r, &mut tr, &lag, red0, a_vars, 2);
    let (mut w_a, mut w_n, mut w_e) = (zero(), zero(), zero());
    cursor = 0;
    t = 0;
    while (t < 7) {
        let b = bits[t];
        let na = relation::adv(t);
        // Advice columns: column-major block at blk_off[t].
        let cl = relation::col_slots_log(t);
        let hi = b + cl;
        let cols = mle::eq_table(&zs, b, cl);
        let mut col_sum = zero();
        i = 0;
        while (i < na) {
            col_sum = col_sum.add(&mu_pows[cursor + i].mul(&cols[i]));
            i = i + 1;
        };
        let blk = eq_const(blk_off[t] >> (hi as u8), &zs, hi, a_vars - hi);
        w_a = w_a.add(&blk.mul(&eq_range(&rp, 0, &zs, 0, b)).mul(&col_sum));
        cursor = cursor + na;
        // Source columns: row-major CHART (8 slots) / TRACE (4 slots).
        let ns = relation::src(t);
        if (ns > 0) {
            let sl = if (t == 4) 3 else 2;
            let mut src_sum = zero();
            i = 0;
            while (i < ns) {
                src_sum = src_sum.add(&mu_pows[cursor + i].mul(&eq_const(i, &zs, 0, sl)));
                i = i + 1;
            };
            let term = src_sum.mul(&eq_range(&rp, 0, &zs, sl, b)).mul(&pad_factor(&zs, sl + b));
            if (t == 4) w_n = term else w_e = term;
            cursor = cursor + ns;
        };
        t = t + 1;
    };
    let adv_eval = reader::scalar(&mut r);
    let chart_eval = reader::scalar(&mut r);
    let mut finals = vector[adv_eval, chart_eval];
    let trace_eval = if (st.mode == MODE_CALLDATA) {
        trace_eval_calldata(trace_t, trace_la, st.n, bits[5], &zs)
    } else {
        let te = reader::scalar(&mut r);
        finals.push_back(te);
        te
    };
    assert!(
        fr::eq(&red_claim, &adv_eval.mul(&w_a).add(&chart_eval.mul(&w_n)).add(&trace_eval.mul(&w_e))),
        EReduction,
    );
    transcript::absorb_scalars(&mut tr, &finals);

    // Batched Zeromorph opening of ADV + ν·CHART (+ ν²·TRACE) at z*.
    let nu = transcript::squeeze(&mut tr);
    let chart_c = bls12381::g1_from_bytes(&st.chart.commitment);
    let mut commitment = bls12381::g1_add(&adv_c, &bls12381::g1_mul(&nu, &chart_c));
    let mut value = adv_eval.add(&nu.mul(&chart_eval));
    if (st.mode == MODE_COMMITTED) {
        let nu2 = nu.mul(&nu);
        let tc = bls12381::g1_from_bytes(&st.trace_commitment);
        commitment = bls12381::g1_add(&commitment, &bls12381::g1_mul(&nu2, &tc));
        value = value.add(&nu2.mul(&trace_eval));
    };
    zeromorph::verify(vk, &commitment, &zs, &value, &mut r, &mut tr);
    reader::finish(&r);

    VerifiedScore {
        score: 1_000_000 * achieved / maximum,
        achieved_points: achieved,
        maximum_points: maximum,
        judgements: vector[c[0], c[1], c[2], c[3], c[4], components - hits],
    }
}
