#[test_only]
module mania_gkr::competition_tests;

use mania_gkr::competition::{Self, Challenge};
use mania_gkr::fixtures;
use mania_gkr::registry::{Self, OrganizerCap, Registry, Session};
use mania_gkr::test_util::{clock_at, finish, setup_registry};
use mania_gkr::verifier;
use std::hash::sha2_256;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ORGANIZER: address = @0xA;
const ONE: address = @0xB;
const TWO: address = @0xC;
const THREE: address = @0xD;
const FOUR: address = @0xE;
const FIVE: address = @0xF;
const SIX: address = @0x10;
const GAME_END: u64 = 21_600_001;
const CLAIM_END: u64 = GAME_END + 900_000;
const FUTURE_START: u64 = 60_001;
const FUTURE_END: u64 = FUTURE_START + 21_600_000;

fun setup_at(start_at_ms: u64): (Scenario, OrganizerCap, Clock) {
    let easy = fixtures::case_demo_a();
    let hard = fixtures::case_random0_a();
    let (mut sc, org) = setup_registry(&easy, vector[], vector[]);
    let mut reg = sc.take_shared<Registry>();
    registry::add_chart_for_testing(&mut reg, hard.chart_hash(), verifier::new_chart_record(
        hard.chart_commitment(), hard.m(), hard.bits(), hard.components(), hard.max_end(),
    ));
    let clk = clock_at(&mut sc, 1);
    competition::create<SUI>(
        &reg, &org, b"2026-09-27", sha2_256(b"versu:2026-09-27"),
        easy.chart_hash(), hard.chart_hash(), fixtures::device_address(), start_at_ms,
        900_000, &clk, sc.ctx(),
    );
    ts::return_shared(reg);
    sc.next_tx(ORGANIZER);
    (sc, org, clk)
}

fun setup(): (Scenario, OrganizerCap, Clock) { setup_at(1) }

fun finish_challenge(sc: Scenario, org: OrganizerCap, clk: Clock) {
    finish(sc, org, clk);
}

fun claim(sc: &mut Scenario, c: Challenge<SUI>, wallet: address, difficulty: u8, clk: &Clock): Challenge<SUI> {
    ts::return_shared(c);
    sc.next_tx(wallet);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::register_claim(&mut c, difficulty, clk, sc.ctx());
    c
}

fun buy(sc: &mut Scenario, wallet: address, difficulty: u8, clk: &Clock) {
    sc.next_tx(wallet);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::buy_plays(
        &mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), difficulty, clk, sc.ctx(),
    );
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
}

/// This helper injects native accepted scores ONLY in unit tests, to test vault
/// economics independently from the expensive existing GKR proof fixtures.
fun verified_score(sc: &mut Scenario, wallet: address, difficulty: u8, score: u64, clk: &Clock): ID {
    sc.next_tx(wallet);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, difficulty, clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let mut session = sc.take_shared_by_id<Session>(sid);
    registry::accept_score_for_testing(&mut session, score);
    competition::record_score(&mut c, &session, clk);
    ts::return_shared(session);
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    sid
}

#[test]
fun one_wallet_buys_independent_plays_and_both_charts_are_bound() {
    let (mut sc, org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, ONE, 1, &clk);
    let easy_sid = verified_score(&mut sc, ONE, 0, 0, &clk);
    let hard_sid = verified_score(&mut sc, ONE, 1, 80, &clk);
    let reg = sc.take_shared<Registry>();
    let easy = sc.take_shared_by_id<Session>(easy_sid);
    let hard = sc.take_shared_by_id<Session>(hard_sid);
    assert!(registry::session_matches(&easy, object::id(&reg), ONE,
        sha2_256(b"versu:2026-09-27"), fixtures::case_demo_a().chart_hash(),
        fixtures::device_address(), 3));
    assert!(registry::session_matches(&hard, object::id(&reg), ONE,
        sha2_256(b"versu:2026-09-27"), fixtures::case_random0_a().chart_hash(),
        fixtures::device_address(), 3));
    ts::return_shared(easy);
    ts::return_shared(hard);
    ts::return_shared(reg);
    let c = sc.take_shared<Challenge<SUI>>();
    assert!(competition::remaining_plays(&c, ONE, 0) == 2);
    assert!(competition::remaining_plays(&c, ONE, 1) == 2);
    assert!(competition::attempt_recorded(&c, easy_sid));
    assert!(competition::attempt_recorded(&c, hard_sid));
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    clk.set_for_testing(CLAIM_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::settle(&mut c, &clk, sc.ctx());
    assert!(competition::refund_eligible(&c, ONE, 0));
    assert!(competition::refund_eligible(&c, ONE, 1));
    competition::refund(&mut c, ONE, 0, &clk, sc.ctx());
    assert!(!competition::refund_eligible(&c, ONE, 0));
    assert!(competition::refund_eligible(&c, ONE, 1));
    competition::refund(&mut c, ONE, 1, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 0);
    assert!(competition::pot_value(&c, 1) == 0);
    ts::return_shared(c);
    finish_challenge(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::ENoPlays)]
fun easy_credits_cannot_start_hard_session() {
    let (mut sc, _org, clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    sc.next_tx(ONE);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::start_paid(&mut c, &reg, 1, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::ENoPlays)]
fun hard_credits_cannot_start_easy_session() {
    let (mut sc, _org, clk) = setup();
    buy(&mut sc, ONE, 1, &clk);
    sc.next_tx(ONE);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::start_paid(&mut c, &reg, 0, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::ERefund)]
fun easy_purchaser_cannot_refund_hard_pool() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, TWO, 1, &clk);
    clk.set_for_testing(CLAIM_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::settle(&mut c, &clk, sc.ctx());
    assert!(!competition::refund_eligible(&c, ONE, 1));
    assert!(competition::refund_eligible(&c, TWO, 1));
    competition::refund(&mut c, ONE, 1, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EConfig)]
fun cannot_schedule_start_in_the_past() {
    let (mut sc, org, clk) = setup();
    let reg = sc.take_shared<Registry>();
    competition::create<SUI>(
        &reg, &org, b"2026-09-27", sha2_256(b"versu:2026-09-27"),
        fixtures::case_demo_a().chart_hash(), fixtures::case_random0_a().chart_hash(),
        fixtures::device_address(), 0, 900_000, &clk, sc.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun future_start_rejects_purchase_before_start() {
    let (mut sc, _org, clk) = setup_at(FUTURE_START);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), 0, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun future_start_rejects_paid_session_before_start() {
    let (mut sc, _org, clk) = setup_at(FUTURE_START);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::start_paid(&mut c, &reg, 0, &clk, sc.ctx());
    abort 0
}

#[test]
fun scheduled_start_and_last_millisecond_accept_scores_and_cutoff_opens_claims() {
    let (mut sc, org, mut clk) = setup_at(FUTURE_START);
    clk.set_for_testing(FUTURE_START);
    buy(&mut sc, ONE, 0, &clk);
    verified_score(&mut sc, ONE, 0, 50, &clk);
    sc.next_tx(ONE);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, 0, &clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let mut session = sc.take_shared_by_id<Session>(sid);
    registry::accept_score_for_testing(&mut session, 75);
    clk.set_for_testing(FUTURE_END - 1);
    competition::record_score(&mut c, &session, &clk);
    assert!(competition::attempt_recorded(&c, sid));
    ts::return_shared(session);
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    clk.set_for_testing(FUTURE_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, ONE, 0, &clk);
    assert!(competition::claim_registered(&c, ONE));
    assert!(competition::ranked_wallet(&c, 0, 1) == ONE);
    ts::return_shared(c);
    finish_challenge(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun scheduled_claim_cannot_open_before_exact_cutoff() {
    let (mut sc, _org, mut clk) = setup_at(FUTURE_START);
    clk.set_for_testing(FUTURE_START);
    buy(&mut sc, ONE, 0, &clk);
    verified_score(&mut sc, ONE, 0, 50, &clk);
    clk.set_for_testing(FUTURE_END - 1);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, ONE, 0, &clk);
    abort 0
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun scheduled_score_rejects_exact_cutoff() {
    let (mut sc, _org, mut clk) = setup_at(FUTURE_START);
    clk.set_for_testing(FUTURE_START);
    buy(&mut sc, ONE, 0, &clk);
    sc.next_tx(ONE);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    let sid = competition::start_paid(&mut c, &reg, 0, &clk, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(c);
    sc.next_tx(ORGANIZER);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let mut session = sc.take_shared_by_id<Session>(sid);
    registry::accept_score_for_testing(&mut session, 50);
    clk.set_for_testing(FUTURE_END);
    competition::record_score(&mut c, &session, &clk);
    abort 0
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun six_hour_entry_cutoff_cannot_be_shortened() {
    let (mut sc, _org, mut clk) = setup();
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(1_000_000, sc.ctx()), 0, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EClosed)]
fun six_hour_start_cutoff_is_exact() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let reg = sc.take_shared<Registry>();
    competition::start_paid(&mut c, &reg, 0, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EConfig)]
fun tiny_claim_window_is_rejected() {
    let (mut sc, org, clk) = setup();
    let reg = sc.take_shared<Registry>();
    competition::create<SUI>(
        &reg, &org, b"2026-09-27", sha2_256(b"versu:2026-09-27"),
        fixtures::case_demo_a().chart_hash(), fixtures::case_random0_a().chart_hash(),
        fixtures::device_address(), 1, 1, &clk, sc.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = competition::EPrice)]
fun wrong_coin_amount_rejected() {
    let (mut sc, _org, clk) = setup();
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::buy_plays(&mut c, coin::mint_for_testing<SUI>(999_999, sc.ctx()), 0, &clk, sc.ctx());
    abort 0
}

#[test, expected_failure(abort_code = competition::EScore)]
fun claim_requires_native_score_on_selected_difficulty() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    verified_score(&mut sc, ONE, 0, 100, &clk);
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, ONE, 1, &clk);
    abort 0
}

#[test, expected_failure(abort_code = competition::EScore)]
fun another_wallet_cannot_claim_a_players_score() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    verified_score(&mut sc, ONE, 0, 20, &clk);
    clk.set_for_testing(GAME_END);
    let c = sc.take_shared<Challenge<SUI>>();
    let _c = claim(&mut sc, c, TWO, 0, &clk);
    abort 0
}

#[test, expected_failure(abort_code = competition::EClaim)]
fun one_wallet_cannot_claim_both_prize_slices() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, ONE, 1, &clk);
    verified_score(&mut sc, ONE, 0, 20, &clk);
    verified_score(&mut sc, ONE, 1, 30, &clk);
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, ONE, 0, &clk);
    c = claim(&mut sc, c, ONE, 1, &clk);
    abort 0
}

#[test]
fun claim_order_cannot_sweep_other_people_and_missing_shares_refund() {
    let (mut sc, org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, TWO, 1, &clk);
    verified_score(&mut sc, ONE, 0, 50, &clk);
    verified_score(&mut sc, TWO, 1, 30, &clk);
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, TWO, 1, &clk);
    c = claim(&mut sc, c, ONE, 0, &clk);
    c = claim(&mut sc, c, ONE, 0, &clk);
    assert!(competition::ranked_wallet(&c, 0, 1) == ONE);
    assert!(competition::ranked_wallet(&c, 1, 1) == TWO);
    assert!(competition::pot_value(&c, 0) == 1_000_000);
    assert!(competition::pot_value(&c, 1) == 1_000_000); // no early payout
    clk.set_for_testing(CLAIM_END);
    competition::settle(&mut c, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 600_000);
    assert!(competition::pot_value(&c, 1) == 600_000);
    competition::refund(&mut c, TWO, 1, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 600_000);
    assert!(competition::pot_value(&c, 1) == 0);
    competition::refund(&mut c, ONE, 0, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 0);
    ts::return_shared(c);
    finish_challenge(sc, org, clk);
}

#[test]
fun earliest_high_score_beats_late_claims_within_difficulty() {
    let (mut sc, org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, TWO, 0, &clk);
    verified_score(&mut sc, ONE, 0, 80, &clk);
    verified_score(&mut sc, TWO, 0, 80, &clk);
    clk.set_for_testing(GAME_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    c = claim(&mut sc, c, TWO, 0, &clk);
    c = claim(&mut sc, c, ONE, 0, &clk);
    assert!(competition::ranked_wallet(&c, 0, 1) == ONE);
    assert!(competition::ranked_wallet(&c, 0, 2) == TWO);
    ts::return_shared(c);
    finish_challenge(sc, org, clk);
}

/// One isolated Sui round with test-only accepted hardware scores and wallet claims. Independent credits, chart ranks, settlement and refunds run in
/// the actual vault code; SUI stands in for unavailable Circle testnet USDC.
#[test]
fun six_wallet_round_refunds_unclaimed_shares_per_difficulty() {
    let (mut sc, org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    buy(&mut sc, ONE, 1, &clk);
    buy(&mut sc, TWO, 0, &clk);
    buy(&mut sc, THREE, 0, &clk);
    buy(&mut sc, FOUR, 0, &clk);
    buy(&mut sc, FIVE, 1, &clk);
    buy(&mut sc, SIX, 1, &clk);

    verified_score(&mut sc, ONE, 0, 90, &clk);
    verified_score(&mut sc, ONE, 1, 80, &clk);
    verified_score(&mut sc, TWO, 0, 70, &clk);
    verified_score(&mut sc, THREE, 0, 60, &clk);
    verified_score(&mut sc, FOUR, 0, 100, &clk); // higher score, no wallet claim
    verified_score(&mut sc, FIVE, 1, 80, &clk);
    clk.set_for_testing(GAME_END - 2); // registry needs expiry > now; vault stops at GAME_END
    verified_score(&mut sc, SIX, 1, 60, &clk);

    let mut c = sc.take_shared<Challenge<SUI>>();
    assert!(competition::pot_value(&c, 0) == 4_000_000);
    assert!(competition::pot_value(&c, 1) == 3_000_000);
    assert!(competition::remaining_plays(&c, ONE, 0) == 2);
    assert!(competition::remaining_plays(&c, ONE, 1) == 2);
    assert!(competition::remaining_plays(&c, SIX, 1) == 2);
    clk.set_for_testing(GAME_END);
    c = claim(&mut sc, c, SIX, 1, &clk);
    c = claim(&mut sc, c, THREE, 0, &clk);
    c = claim(&mut sc, c, FIVE, 1, &clk);
    c = claim(&mut sc, c, TWO, 0, &clk);
    c = claim(&mut sc, c, ONE, 0, &clk);
    assert!(competition::ranked_wallet(&c, 0, 1) == ONE);
    assert!(competition::ranked_wallet(&c, 0, 2) == TWO);
    assert!(competition::ranked_wallet(&c, 0, 3) == THREE);
    assert!(competition::ranked_wallet(&c, 1, 1) == FIVE);
    assert!(competition::ranked_wallet(&c, 1, 2) == SIX);
    assert!(competition::pot_value(&c, 0) == 4_000_000);
    assert!(competition::pot_value(&c, 1) == 3_000_000); // no early payout

    clk.set_for_testing(CLAIM_END);
    competition::settle(&mut c, &clk, sc.ctx());
    // Three Easy ranks pay 80% of Easy; two Hard ranks pay 60% of Hard.
    assert!(competition::pot_value(&c, 0) == 800_000);
    assert!(competition::pot_value(&c, 1) == 1_200_000);
    competition::refund(&mut c, ONE, 0, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 600_000);
    assert!(competition::pot_value(&c, 1) == 1_200_000);
    competition::refund(&mut c, ONE, 1, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 600_000);
    assert!(competition::pot_value(&c, 1) == 800_000);
    competition::refund(&mut c, TWO, 0, &clk, sc.ctx());
    competition::refund(&mut c, THREE, 0, &clk, sc.ctx());
    competition::refund(&mut c, FOUR, 0, &clk, sc.ctx());
    competition::refund(&mut c, FIVE, 1, &clk, sc.ctx());
    competition::refund(&mut c, SIX, 1, &clk, sc.ctx());
    assert!(competition::pot_value(&c, 0) == 0);
    assert!(competition::pot_value(&c, 1) == 0);
    ts::return_shared(c);
    finish_challenge(sc, org, clk);
}

#[test, expected_failure(abort_code = competition::EScore)]
fun recorded_session_cannot_be_replayed() {
    let (mut sc, _org, clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    let sid = verified_score(&mut sc, ONE, 0, 0, &clk);
    let mut c = sc.take_shared<Challenge<SUI>>();
    let session = sc.take_shared_by_id<Session>(sid);
    competition::record_score(&mut c, &session, &clk);
    abort 0
}

#[test, expected_failure(abort_code = competition::ERefund)]
fun refund_once_only() {
    let (mut sc, _org, mut clk) = setup();
    buy(&mut sc, ONE, 0, &clk);
    clk.set_for_testing(CLAIM_END);
    let mut c = sc.take_shared<Challenge<SUI>>();
    competition::settle(&mut c, &clk, sc.ctx());
    competition::refund(&mut c, ONE, 0, &clk, sc.ctx());
    competition::refund(&mut c, ONE, 0, &clk, sc.ctx());
    abort 0
}
