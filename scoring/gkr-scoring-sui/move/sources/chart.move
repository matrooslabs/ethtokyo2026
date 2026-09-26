/// On-chain chart validation and commitment check (SPEC §8.1): the chart bytes are
/// validated against every V1 rule, hashed to the SP1 `chartHash`, and bound to the KZG
/// commitment C_N by opening it at a transcript-derived point. The per-note pass is
/// resumable (`process`) so a 10,000-note chart can be checked over several transactions.
module mania_gkr::chart;

use mania_gkr::fr::{Self, zero};
use mania_gkr::mle;
use mania_gkr::reader;
use mania_gkr::transcript;
use mania_gkr::verifier::{Self, ChartRecord};
use mania_gkr::zeromorph::{Self, VerifierKey};
use std::hash::sha2_256;
use sui::bls12381::{Self, Scalar};
use sui::group_ops::Element;

use fun fr::add as Element.add;
use fun fr::mul as Element.mul;

const CHART_DOMAIN: vector<u8> = b"OSUMANIA_GKR_SUI_CHART_V1";
const MAGIC: vector<u8> = b"OSUMANIA_CHART_V1";
const HEADER_BYTES: u64 = 24;
const NOTE_BYTES: u64 = 17;
const MAX_NOTES: u64 = 10_000;
const MAX_DURATION_US: u64 = 1_800_000_000;
const W: u64 = 136_500;

const EEncoding: u64 = 1;
const EInvalidChart: u64 = 2;
const ESrsSize: u64 = 3;
const EIncomplete: u64 = 4;

/// Progress of one chart check.
public struct ChartCheck has drop, store {
    chart_hash: vector<u8>,
    commitment: vector<u8>,
    u: vector<Element<Scalar>>,
    m: u64,
    bits: u64,
    next: u64,
    /// Σ_k eq(k, u_{≥3})·(lane·e0 + s·e1 + e·e2 + hold·e3 + kl·e4) so far.
    acc: Element<Scalar>,
    last_end: vector<u64>,
    seen: vector<bool>,
    kl: vector<Element<Scalar>>,
    prev_s: u64,
    prev_lane: u64,
    components: u64,
    max_end: u64,
}

fun be(b: &vector<u8>, off: u64, len: u64): u64 {
    let mut x = 0u64;
    let mut i = 0;
    while (i < len) {
        x = (x << 8) | (b[off + i] as u64);
        i = i + 1;
    };
    x
}

/// Header checks, chartHash and the opening point.
public fun begin(vk: &VerifierKey, bytes: &vector<u8>, commitment: vector<u8>): ChartCheck {
    let len = bytes.length();
    assert!(len >= HEADER_BYTES, EEncoding);
    let magic = MAGIC;
    let mut i = 0;
    while (i < 17) {
        assert!(bytes[i] == magic[i], EEncoding);
        i = i + 1;
    };
    assert!(be(bytes, 17, 2) == 1 && bytes[19] == 4, EEncoding);
    let m = be(bytes, 20, 4);
    assert!(m >= 1 && m <= MAX_NOTES && len == HEADER_BYTES + NOTE_BYTES * m, EInvalidChart);
    let bits = mle::log2_ceil(m);
    assert!(3 + bits <= zeromorph::smax(vk), ESrsSize);
    let chart_hash = sha2_256(*bytes);
    let _ = bls12381::g1_from_bytes(&commitment);
    let mut tr = transcript::new(CHART_DOMAIN);
    transcript::absorb(&mut tr, vector[chart_hash, commitment]);
    let z = zero();
    ChartCheck {
        chart_hash,
        commitment,
        u: transcript::squeeze_n(&mut tr, 3 + bits),
        m,
        bits,
        next: 0,
        acc: z,
        last_end: vector[0, 0, 0, 0],
        seen: vector[false, false, false, false],
        kl: vector[z, z, z, z],
        prev_s: 0,
        prev_lane: 0,
        components: 0,
        max_end: 0,
    }
}

/// Validates and accumulates up to `max_notes` further notes.
public fun process(c: &mut ChartCheck, bytes: &vector<u8>, max_notes: u64) {
    let u = &c.u;
    let e: vector<Element<Scalar>> = vector::tabulate!(5, |j| mle::eq_const(j, u, 0, 3));
    let lane_terms = vector[zero(), e[0], e[0].add(&e[0]), e[0].add(&e[0]).add(&e[0])];
    let mut rows = mle::new_eq_rows(u, 3, c.bits);
    let one = fr::one();
    let end = if (c.m - c.next < max_notes) c.m else c.next + max_notes;
    let mut k = c.next;
    while (k < end) {
        let off = HEADER_BYTES + NOTE_BYTES * k;
        let lane = bytes[off] as u64;
        let (s_f, s) = fr::from_be8(bytes, off + 1);
        let (e_f, en) = fr::from_be8(bytes, off + 9);
        assert!(lane < 4 && s <= en && en <= MAX_DURATION_US - W, EInvalidChart);
        assert!(k == 0 || s > c.prev_s || (s == c.prev_s && lane > c.prev_lane), EInvalidChart);
        assert!(!c.seen[lane] || s > c.last_end[lane], EInvalidChart);
        let hold = en > s;
        let mut val = lane_terms[lane].add(&s_f.mul(&e[1])).add(&e_f.mul(&e[2])).add(&c.kl[lane].mul(&e[4]));
        if (hold) val = val.add(&e[3]);
        c.acc = c.acc.add(&rows.at(k).mul(&val));
        *&mut c.seen[lane] = true;
        *&mut c.last_end[lane] = en;
        *&mut c.kl[lane] = c.kl[lane].add(&one);
        c.components = c.components + if (hold) 2 else 1;
        if (en > c.max_end) c.max_end = en;
        c.prev_s = s;
        c.prev_lane = lane;
        k = k + 1;
    };
    c.next = end;
}

public fun done(c: &ChartCheck): bool { c.next == c.m }

/// Zeromorph opening of C_N at u to the accumulated CHART(u).
public fun finish(
    c: ChartCheck,
    vk: &VerifierKey,
    proof: vector<vector<vector<u8>>>,
): (vector<u8>, ChartRecord) {
    assert!(c.next == c.m, EIncomplete);
    let mut tr = transcript::new(CHART_DOMAIN);
    transcript::absorb(&mut tr, vector[c.chart_hash, c.commitment]);
    let u = transcript::squeeze_n(&mut tr, 3 + c.bits);
    transcript::absorb_scalars(&mut tr, &vector[c.acc]);
    let mut r = reader::new(proof);
    zeromorph::verify(vk, &bls12381::g1_from_bytes(&c.commitment), &u, &c.acc, &mut r, &mut tr);
    reader::finish(&r);
    (c.chart_hash, verifier::new_chart_record(c.commitment, c.m, c.bits, c.components, c.max_end))
}

/// One-shot check (small charts).
public fun check(
    vk: &VerifierKey,
    bytes: &vector<u8>,
    commitment: vector<u8>,
    proof: vector<vector<vector<u8>>>,
): (vector<u8>, ChartRecord) {
    let mut c = begin(vk, bytes, commitment);
    process(&mut c, bytes, MAX_NOTES);
    finish(c, vk, proof)
}
