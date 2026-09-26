#[test_only]
module mania_gkr::test_util;

use mania_gkr::chart;
use mania_gkr::fixtures::{Self, Case};
use mania_gkr::registry::{Self, Registry, OrganizerCap, Session};
use mania_gkr::verifier;
use mania_gkr::zeromorph::{Self, VerifierKey};
use sui::bls12381::{Self, Scalar};
use sui::clock::{Self, Clock};
use sui::group_ops::Element;
use sui::test_scenario::{Self as ts, Scenario};

const ORGANIZER: address = @0xA;
const PLAYER: address = @0xB;
const RELAYER: address = @0xC;
const EXPIRES_MS: u64 = 1_000_000;

public fun vk(): VerifierKey { zeromorph::new_vk(fixtures::vk_g2_tau(), fixtures::vk_g2_shift()) }

/// Splits into ≤16 KiB pieces, as a PTB passes large byte strings.
public fun split(b: vector<u8>): vector<vector<u8>> {
    let mut out = vector[];
    let mut cur = vector[];
    let mut i = 0;
    while (i < b.length()) {
        cur.push_back(b[i]);
        if (cur.length() == 16_000) {
            out.push_back(cur);
            cur = vector[];
        };
        i = i + 1;
    };
    if (!cur.is_empty() || out.is_empty()) out.push_back(cur);
    out
}

public fun check_verify(c: &Case, t: vector<vector<u8>>, la: vector<u8>) { check_verify_proof(c, c.proof(), t, la) }

public fun check_verify_proof(c: &Case, proof: vector<vector<vector<u8>>>, t: vector<vector<u8>>, la: vector<u8>) {
    let vk = vk();
    assert!(zeromorph::id(&vk) == fixtures::srs_id());
    let rec = verifier::new_chart_record(c.chart_commitment(), c.m(), c.bits(), c.components(), c.max_end());
    let st = verifier::new_statement(
        c.mode(),
        c.digest(),
        c.n(),
        c.duration(),
        rec,
        c.trace_commitment(),
        c.lane_bits(),
        c.counts(),
    );
    let v = verifier::verify(&vk, &st, proof, &scalars(t), &la);
    assert!(verifier::score(&v) == c.score());
    assert!(verifier::judgements(&v) == c.judgements());
}

public fun scalars(t: vector<vector<u8>>): vector<Element<Scalar>> {
    t.map!(|b| bls12381::scalar_from_bytes(&b))
}

public fun check_chart(c: &Case, bytes: vector<u8>, proof: vector<vector<vector<u8>>>) {
    let (hash, rec) = chart::check(&vk(), &bytes, c.chart_commitment(), proof);
    assert!(hash == c.chart_hash());
    assert!(verifier::chart_m(&rec) == c.m() && verifier::chart_bits(&rec) == c.bits());
    assert!(verifier::chart_components(&rec) == c.components());
    assert!(verifier::chart_max_end(&rec) == c.max_end());
}

public fun header(c: &Case): registry::Header {
    registry::new_header_for_testing(
        c.chain_id(),
        c.verifier(),
        c.match_id(),
        c.session_id(),
        c.challenge(),
        c.player(),
        c.device(),
        c.chart_hash(),
        c.ruleset_id(),
        c.bitstream_hash(),
        c.input_policy_hash(),
    )
}

/// Registry with the demo device and the case's chart; returns the scenario at a fresh tx.
/// With chart bytes the real on-chain check runs; without, the record is injected (a unit
/// test has one gas meter, while on-chain registration is its own transaction).
public fun setup_registry(c: &Case, chart_bytes: vector<u8>, chart_proof: vector<vector<vector<u8>>>): (Scenario, OrganizerCap) {
    let mut sc = ts::begin(ORGANIZER);
    let cap = registry::create_for_testing(
        fixtures::vk_g2_tau(),
        fixtures::vk_g2_shift(),
        c.chain_id(),
        c.verifier(),
        sc.ctx(),
    );
    sc.next_tx(ORGANIZER);
    let mut reg = sc.take_shared<Registry>();
    assert!(registry::device_address(&fixtures::device_pubkey()) == fixtures::device_address());
    registry::set_device(&mut reg, &cap, fixtures::device_pubkey(), c.bitstream_hash(), true);
    if (!chart_bytes.is_empty()) {
        let mut up = registry::new_chart_upload(sc.ctx());
        split(chart_bytes).do!(|chunk| registry::append_chart(&mut up, chunk));
        registry::begin_chart(&reg, &mut up, c.chart_commitment());
        registry::process_chart(&mut up, 10_000);
        let h = registry::register_chart(&mut reg, &cap, up, chart_proof);
        assert!(h == c.chart_hash());
    } else {
        let rec = verifier::new_chart_record(c.chart_commitment(), c.m(), c.bits(), c.components(), c.max_end());
        registry::add_chart_for_testing(&mut reg, c.chart_hash(), rec);
    };
    ts::return_shared(reg);
    sc.next_tx(ORGANIZER);
    (sc, cap)
}

/// Registry, chart and a session with the case's header, opened in `mode`.
public fun setup_session(
    c: &Case,
    mode: u8,
    chart_bytes: vector<u8>,
    chart_proof: vector<vector<vector<u8>>>,
): (Scenario, OrganizerCap) {
    let (mut sc, cap) = setup_registry(c, chart_bytes, chart_proof);
    let reg = sc.take_shared<Registry>();
    registry::open_session_for_testing(&reg, header(c), PLAYER, mode, EXPIRES_MS, sc.ctx());
    ts::return_shared(reg);
    sc.next_tx(RELAYER);
    (sc, cap)
}

public fun clock_at(sc: &mut Scenario, ms: u64): Clock {
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(ms);
    clk
}

/// Submits the case as-is (or with overrides) in the mode of `c`. Mode A uploads `events`
/// for real when given, else injects the staged trace (`t`, `la`).
public fun submit(
    reg: &Registry,
    s: &mut Session,
    c: &Case,
    duration: u64,
    counts: vector<u64>,
    events: vector<vector<u8>>,
    t: vector<vector<u8>>,
    la: vector<u8>,
    sig: vector<u8>,
    clk: &Clock,
    ctx: &mut TxContext,
): u64 {
    if (c.mode() == 1) {
        let up = if (!events.is_empty()) {
            let mut up = registry::new_trace_upload(s, ctx);
            registry::append_trace(&mut up, events);
            up
        } else {
            registry::trace_upload_for_testing(s, c.trace_root(), scalars(t), la, ctx)
        };
        registry::submit_calldata(reg, s, up, duration, c.lane_bits(), counts, c.proof(), sig, clk)
    } else {
        registry::submit_committed(
            reg,
            s,
            c.n(),
            c.trace_root(),
            c.trace_commitment(),
            duration,
            c.lane_bits(),
            counts,
            c.proof(),
            sig,
            clk,
        )
    }
}

public fun finish(sc: Scenario, cap: OrganizerCap, clk: Clock) {
    clk.destroy_for_testing();
    transfer::public_transfer(cap, ORGANIZER);
    sc.end();
}

/// Mode-A trace upload in one transaction: SHA-256 chain and staged contents.
public fun check_upload(c: &Case, events: vector<vector<u8>>) {
    let (mut sc, cap) = setup_session(c, 1, vector[], vector[]);
    let s = sc.take_shared<Session>();
    let mut up = registry::new_trace_upload(&s, sc.ctx());
    registry::append_trace(&mut up, events);
    assert!(registry::trace_root(&up) == c.trace_root() && registry::trace_len(&up) == c.n());
    transfer::public_transfer(up, RELAYER);
    ts::return_shared(s);
    let clk = clock_at(&mut sc, 1);
    finish(sc, cap, clk);
}

/// Full on-chain path: device + chart registration, session, relayed submission.
public fun check_submit(
    c: &Case,
    chart_bytes: vector<u8>,
    chart_proof: vector<vector<vector<u8>>>,
    events: vector<vector<u8>>,
    t: vector<vector<u8>>,
    la: vector<u8>,
) {
    let (mut sc, cap) = setup_session(c, c.mode(), chart_bytes, chart_proof);
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    let score = submit(&reg, &mut s, c, c.duration(), c.counts(), events, t, la, c.sig(), &clk, sc.ctx());
    assert!(score == c.score());
    assert!(registry::consumed(&s) && registry::session_score(&s) == c.score());
    assert!(registry::session_judgements(&s) == c.judgements());
    ts::return_shared(s);
    ts::return_shared(reg);
    finish(sc, cap, clk);
}
