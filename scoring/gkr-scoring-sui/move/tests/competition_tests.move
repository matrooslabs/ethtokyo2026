#[test_only]
module mania_gkr::competition_tests;

use mania_gkr::competition::{Self, Competition};
use mania_gkr::fixtures;
use mania_gkr::registry::{Self, Registry, Session};
use mania_gkr::test_util::{clock_at, finish, setup_registry};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;

const ORGANIZER: address = @0xA;
const PLAYER: address = @0xB;
const OTHER: address = @0xC;
const ROUND: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUMAN: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fun setup(): (ts::Scenario, mania_gkr::registry::OrganizerCap, sui::clock::Clock) {
    let case = fixtures::case_demo_a();
    let (mut sc, org) = setup_registry(&case, vector[], vector[]);
    let reg = sc.take_shared<Registry>();
    let clk = clock_at(&mut sc, 1);
    let cap = competition::create<SUI>(
        &reg, &org, ROUND, case.chart_hash(), fixtures::device_address(),
        10, 20, 30, 40, &clk, sc.ctx(),
    );
    ts::return_shared(reg);
    sc.next_tx(ORGANIZER);
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::attest_identity(&mut c, &cap, PLAYER, HUMAN);
    // A retried backend transaction does not consume a second identity.
    competition::attest_identity(&mut c, &cap, PLAYER, HUMAN);
    ts::return_shared(c);
    transfer::public_transfer(cap, ORGANIZER);
    sc.next_tx(PLAYER);
    (sc, org, clk)
}

#[test]
fun purchase_start_and_no_winner_refund() {
    let (mut sc, org, mut clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    assert!(competition::remaining_plays(&c, PLAYER) == 3);
    assert!(competition::pot_value(&c) == 1_000_000);
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    assert!(competition::remaining_plays(&c, PLAYER) == 2);
    assert!(!competition::attempt_recorded(&c, sid));
    ts::return_shared(c);
    ts::return_shared(reg);
    sc.next_tx(OTHER);
    let mut c = sc.take_shared<Competition<SUI>>();
    clk.set_for_testing(31);
    competition::refund(&mut c, PLAYER, &clk, sc.ctx());
    assert!(competition::pot_value(&c) == 0);
    ts::return_shared(c);
    finish(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::ENoPlays)]
fun fourth_run_requires_another_purchase() {
    let (mut sc, _org, clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    let _first = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    let _second = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    let _third = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    assert!(competition::remaining_plays(&c, PLAYER) == 0);
    let _fourth = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    abort 0
}

#[test]
fun another_pack_adds_three_fresh_plays() {
    let (mut sc, org, clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    let _first = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    let _second = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    let _third = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    assert!(competition::remaining_plays(&c, PLAYER) == 3);
    assert!(competition::pot_value(&c) == 2_000_000);
    ts::return_shared(c);
    ts::return_shared(reg);
    finish(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::EIdentity)]
fun same_person_cannot_bind_second_wallet() {
    let (mut sc, _org, _clk) = setup();
    sc.next_tx(ORGANIZER);
    let mut c = sc.take_shared<Competition<SUI>>();
    let cap = sc.take_from_sender<competition::IdentityCap>();
    competition::attest_identity(&mut c, &cap, OTHER, HUMAN);
    abort 0
}

#[test, expected_failure(abort_code = competition::EPrice)]
fun rejects_underpayment_without_credit() {
    let (mut sc, _org, clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(999_999, sc.ctx()), &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EScore)]
fun cannot_record_unverified_attempt() {
    let (mut sc, _org, clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(OTHER);
    let mut c = sc.take_shared<Competition<SUI>>();
    let s = sc.take_shared_by_id<Session>(sid);
    competition::record_score(&mut c, &s, &clk);
    abort 0
}

#[test]
fun verified_zero_wins_and_payout_prevents_refund() {
    let (mut sc, org, mut clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(OTHER);
    let mut c = sc.take_shared<Competition<SUI>>();
    let mut s = sc.take_shared_by_id<Session>(sid);
    registry::accept_score_for_testing(&mut s, 0);
    competition::record_score(&mut c, &s, &clk);
    assert!(competition::attempt_recorded(&c, sid));
    let (has_winner, winner, score) = competition::leader(&c);
    assert!(has_winner && winner == PLAYER && score == 0);
    ts::return_shared(s);
    clk.set_for_testing(31);
    competition::claim_prize(&mut c, &clk, sc.ctx());
    assert!(competition::pot_value(&c) == 0);
    ts::return_shared(c);
    finish(sc, org, clk);
}

#[test]
fun expired_unclaimed_winner_refunds_buyers() {
    let (mut sc, org, mut clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, &clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(OTHER);
    let mut c = sc.take_shared<Competition<SUI>>();
    let mut s = sc.take_shared_by_id<Session>(sid);
    registry::accept_score_for_testing(&mut s, 100);
    competition::record_score(&mut c, &s, &clk);
    ts::return_shared(s);
    clk.set_for_testing(41);
    competition::refund(&mut c, PLAYER, &clk, sc.ctx());
    assert!(competition::pot_value(&c) == 0);
    ts::return_shared(c);
    finish(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::ERefund)]
fun cannot_refund_same_purchase_twice() {
    let (mut sc, _org, mut clk) = setup();
    let mut c = sc.take_shared<Competition<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), &clk, sc.ctx());
    clk.set_for_testing(31);
    competition::refund(&mut c, PLAYER, &clk, sc.ctx());
    competition::refund(&mut c, PLAYER, &clk, sc.ctx());
    abort 0
}
