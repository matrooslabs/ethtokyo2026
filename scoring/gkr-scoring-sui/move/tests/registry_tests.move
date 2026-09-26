#[test_only]
#[allow(unused_variable)]
module mania_gkr::registry_tests;

use mania_gkr::fixtures;
use mania_gkr::registry::{Self, Registry, Session};
use mania_gkr::test_util::{Self, clock_at, finish, setup_registry, setup_session, submit};
use sui::test_scenario as ts;

#[test, expected_failure(abort_code = registry::EConsumed)]
fun replay_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 1, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    submit(&reg, &mut s, &c, c.duration(), c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    submit(&reg, &mut s, &c, c.duration(), c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    ts::return_shared(s);
    ts::return_shared(reg);
    finish(sc, cap, clk);
}

fun flip(mut b: vector<u8>, i: u64): vector<u8> {
    *&mut b[i] = b[i] ^ 1;
    b
}

/// Flips byte `i` of the first event chunk.
fun flip_events(mut ev: vector<vector<u8>>, i: u64): vector<vector<u8>> {
    let c = flip(ev[0], i);
    *&mut ev[0] = c;
    ev
}

#[test, expected_failure(abort_code = registry::ESignature)]
fun forged_signature_is_rejected() {
    let c = fixtures::case_demo_b();
    let (mut sc, cap) = setup_session(&c, 2, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    submit(&reg, &mut s, &c, c.duration(), c.counts(), vector[], vector[], vector[], flip(c.sig(), 5), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::ESignature)]
fun modified_trace_breaks_signature() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 1, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    // Low byte of event 0's timestamp.
    submit(&reg, &mut s, &c, c.duration(), c.counts(), flip_events(fixtures::events_demo_a(), 11), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::ESignature)]
fun modified_duration_breaks_signature() {
    let c = fixtures::case_demo_b();
    let (mut sc, cap) = setup_session(&c, 2, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    submit(&reg, &mut s, &c, c.duration() + 1, c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

/// Claiming one more PERFECT than earned fails inside the proof check.
#[test, expected_failure]
fun inflated_counts_are_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 1, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    let mut counts = c.counts();
    *&mut counts[0] = counts[0] + 1;
    submit(&reg, &mut s, &c, c.duration(), counts, fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::EExpired)]
fun expired_session_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 1, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1_000_001);
    submit(&reg, &mut s, &c, c.duration(), c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::EWrongMode)]
fun mode_confusion_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 2, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    submit(&reg, &mut s, &c, c.duration(), c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::EDeviceRevoked)]
fun revoked_device_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_session(&c, 1, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let mut reg = sc.take_shared<Registry>();
    registry::set_device(&mut reg, &cap, fixtures::device_pubkey(), c.bitstream_hash(), false);
    let mut s = sc.take_shared<Session>();
    let clk = clock_at(&mut sc, 1);
    submit(&reg, &mut s, &c, c.duration(), c.counts(), fixtures::events_demo_a(), vector[], vector[], c.sig(), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = registry::EChartExists)]
fun duplicate_chart_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_registry(&c, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let mut reg = sc.take_shared<Registry>();
    let mut up = registry::new_chart_upload(sc.ctx());
    registry::append_chart(&mut up, fixtures::chart_bytes_demo());
    registry::begin_chart(&reg, &mut up, c.chart_commitment());
    registry::process_chart(&mut up, 10_000);
    registry::register_chart(&mut reg, &cap, up, fixtures::chart_proof_demo());
    abort 0
}

/// A commitment to a different chart fails the opening check.
#[test, expected_failure]
fun foreign_chart_commitment_is_rejected() {
    let c = fixtures::case_demo_a();
    let other = fixtures::case_perfect_a();
    let (mut sc, cap) = setup_registry(&other, fixtures::chart_bytes_perfect(), fixtures::chart_proof_perfect());
    let mut reg = sc.take_shared<Registry>();
    let mut up = registry::new_chart_upload(sc.ctx());
    registry::append_chart(&mut up, fixtures::chart_bytes_demo());
    registry::begin_chart(&reg, &mut up, other.chart_commitment());
    registry::process_chart(&mut up, 10_000);
    registry::register_chart(&mut reg, &cap, up, fixtures::chart_proof_perfect());
    abort 0
}

/// Registration may be split: several `process_chart` calls give the same record.
#[test]
fun chart_check_resumes() {
    let c = fixtures::case_random0_a();
    let (mut sc, cap) = setup_registry(&fixtures::case_demo_a(), fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let mut reg = sc.take_shared<Registry>();
    let mut up = registry::new_chart_upload(sc.ctx());
    registry::append_chart(&mut up, fixtures::chart_bytes_random0());
    registry::begin_chart(&reg, &mut up, c.chart_commitment());
    while (!registry::chart_done(&up)) registry::process_chart(&mut up, 3);
    assert!(registry::register_chart(&mut reg, &cap, up, fixtures::chart_proof_random0()) == c.chart_hash());
    ts::return_shared(reg);
    let clk = clock_at(&mut sc, 1);
    finish(sc, cap, clk);
}

/// A trace chunk that breaks the seq == index rule is rejected at upload.
#[test, expected_failure(abort_code = registry::ETraceEncoding)]
fun trace_sequence_is_enforced() {
    let c = fixtures::case_random0_a();
    let (mut sc, cap) = setup_session(&c, 1, vector[], vector[]);
    let s = sc.take_shared<Session>();
    let mut up = registry::new_trace_upload(&s, sc.ctx());
    registry::append_trace(&mut up, flip_events(fixtures::events_random0_a(), 3));
    abort 0
}

#[test, expected_failure(abort_code = registry::EWrongRegistry)]
fun foreign_cap_is_rejected() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_registry(&c, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let other_cap = registry::create(fixtures::vk_g2_tau(), fixtures::vk_g2_shift(), 1, sc.ctx());
    let mut reg = sc.take_shared<Registry>();
    registry::set_device(&mut reg, &other_cap, fixtures::device_pubkey(), c.bitstream_hash(), true);
    abort 0
}

/// The production `open_session` issues a header the device can sign against.
#[test]
fun open_session_issues_header() {
    let c = fixtures::case_demo_a();
    let (mut sc, cap) = setup_registry(&c, fixtures::chart_bytes_demo(), fixtures::chart_proof_demo());
    let reg = sc.take_shared<Registry>();
    let clk = clock_at(&mut sc, 5);
    let id = registry::open_session(
        &reg,
        &cap,
        c.match_id(),
        c.chart_hash(),
        @0xB,
        fixtures::device_address(),
        100,
        2,
        &clk,
        sc.ctx(),
    );
    ts::return_shared(reg);
    sc.next_tx(@0xC);
    let s = sc.take_shared_by_id<Session>(id);
    let h = registry::header(&s);
    let pre = registry::digest_preimage_v2(h, 1, 2, x"00", x"00");
    // domain(37) ‖ u16 ‖ chain(8) ‖ 20+32+32+32+20+20+32+32+32+32 ‖ n(4) ‖ dur(8) ‖ 1 ‖ 1
    assert!(pre.length() == 37 + 2 + 8 + 284 + 4 + 8 + 2);
    ts::return_shared(s);
    finish(sc, cap, clk);
}
