/// One shared six-hour hardware challenge, with Easy and Hard native Sui GKR charts.
/// Coin<T> must be instantiated with the canonical six-decimal Circle USDC type:
/// exactly 1_000_000 units buys three nontransferable wallet play starts, usable on
/// either chart. World ID is checked only for claims; the IdentityCap operator must
/// verify the round-scoped World proof and wallet ownership before registering one.
module mania_gkr::competition;

use mania_gkr::registry::{Self, OrganizerCap, Registry, Session};
use std::hash::sha2_256;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

const PRICE: u64 = 1_000_000;
const PLAYS_PER_PURCHASE: u64 = 3;
const GAME_DURATION_MS: u64 = 21_600_000;
const MIN_CLAIM_WINDOW_MS: u64 = 900_000;
const MAX_CLAIM_WINDOW_MS: u64 = 604_800_000;
const EASY: u8 = 0;
const HARD: u8 = 1;

const EConfig: u64 = 0;
const EIdentity: u64 = 1;
const ENotBuyer: u64 = 2;
const EPrice: u64 = 3;
const EClosed: u64 = 4;
const ENoPlays: u64 = 5;
const ERegistry: u64 = 6;
const EAttempt: u64 = 7;
const EScore: u64 = 8;
const ESettlement: u64 = 9;
const ERefund: u64 = 10;
const EDifficulty: u64 = 11;

public struct Challenge<phantom T> has key {
    id: UID,
    registry: ID,
    round_date: vector<u8>,
    round_id: vector<u8>,
    easy_chart_hash: vector<u8>,
    hard_chart_hash: vector<u8>,
    device: vector<u8>,
    started_at_ms: u64,
    score_deadline_ms: u64,
    claim_window_ms: u64,
    claim_deadline_ms: u64,
    pot: Balance<T>,
    buyers: Table<address, Buyer>,
    attempts: Table<ID, Attempt>,
    claims: Table<address, ClaimBinding>,
    nullifiers: Table<vector<u8>, address>,
    easy_top: vector<RankedClaim>,
    hard_top: vector<RankedClaim>,
    score_order: u64,
    total_purchases: u64,
    refund_purchases_remaining: u64,
    original_pot: u64,
    refund_pool: u64,
    settled: bool,
}

/// Owned by the trusted off-chain World ID + wallet signature verification service.
public struct IdentityCap has key, store {
    id: UID,
    challenge: ID,
}

public struct Best has copy, drop, store {
    score: u64,
    session: ID,
    order: u64,
}

public struct Buyer has store {
    plays: u64,
    purchases: u64,
    refunded: bool,
    best_easy: Option<Best>,
    best_hard: Option<Best>,
}

public struct Attempt has store {
    wallet: address,
    difficulty: u8,
    recorded: bool,
}

public struct ClaimBinding has store {
    nullifier: vector<u8>,
    difficulty: u8,
}

public struct RankedClaim has copy, drop, store {
    wallet: address,
    session: ID,
    score: u64,
    order: u64,
}

public struct ChallengeCreated has copy, drop {
    challenge: ID,
    registry: ID,
    round_date: vector<u8>,
    round_id: vector<u8>,
    easy_chart_hash: vector<u8>,
    hard_chart_hash: vector<u8>,
    started_at_ms: u64,
    score_deadline_ms: u64,
    claim_window_ms: u64,
    claim_deadline_ms: u64,
}

public struct PlaysPurchased has copy, drop {
    challenge: ID,
    wallet: address,
    remaining_plays: u64,
}

public struct PaidAttemptStarted has copy, drop {
    challenge: ID,
    session: ID,
    wallet: address,
    difficulty: u8,
    remaining_plays: u64,
}

public struct PaidScoreRecorded has copy, drop {
    challenge: ID,
    session: ID,
    wallet: address,
    difficulty: u8,
    score: u64,
    personal_best: bool,
}

public struct ClaimRegistered has copy, drop {
    challenge: ID,
    wallet: address,
    difficulty: u8,
    nullifier: vector<u8>,
    session: ID,
    score: u64,
    provisional_rank: u64,
}

public struct PrizePaid has copy, drop {
    challenge: ID,
    wallet: address,
    difficulty: u8,
    session: ID,
    rank: u64,
    slice_percent: u64,
    share_percent: u64,
    amount: u64,
}

public struct ChallengeSettled has copy, drop {
    challenge: ID,
    original_pot: u64,
    paid_prizes: u64,
    refund_pool: u64,
    easy_winner_count: u64,
    hard_winner_count: u64,
}

public struct EntryRefunded has copy, drop {
    challenge: ID,
    wallet: address,
    amount: u64,
}

fun digit(b: u8): bool { b >= 48 && b <= 57 }

fun valid_date(date: &vector<u8>): bool {
    if (date.length() != 10) return false;
    let mut i = 0;
    while (i < 10) {
        if (i == 4 || i == 7) {
            if (date[i] != 45) return false;
        } else if (!digit(date[i])) return false;
        i = i + 1;
    };
    let month = (date[5] - 48) * 10 + date[6] - 48;
    let day = (date[8] - 48) * 10 + date[9] - 48;
    month >= 1 && month <= 12 && day >= 1 && day <= 31
}

fun chart_for<T>(c: &Challenge<T>, difficulty: u8): vector<u8> {
    assert!(difficulty == EASY || difficulty == HARD, EDifficulty);
    if (difficulty == EASY) c.easy_chart_hash else c.hard_chart_hash
}

/// Both native-verified charts must preexist. Clock fixes the six-hour cutoff;
/// operator chooses ONLY the post-gameplay claim window (24h recommended).
/// Hardware match ID = SHA256(utf8("versu:") || utf8(YYYY-MM-DD)).
public fun create<T>(
    reg: &Registry,
    organizer: &OrganizerCap,
    round_date: vector<u8>,
    round_id: vector<u8>,
    easy_chart_hash: vector<u8>,
    hard_chart_hash: vector<u8>,
    device: vector<u8>,
    claim_window_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): IdentityCap {
    registry::assert_organizer(reg, organizer);
    assert!(valid_date(&round_date) &&
        easy_chart_hash.length() == 32 && hard_chart_hash.length() == 32 &&
        easy_chart_hash != hard_chart_hash && device.length() == 20 &&
        claim_window_ms >= MIN_CLAIM_WINDOW_MS && claim_window_ms <= MAX_CLAIM_WINDOW_MS, EConfig);
    let mut preimage = b"versu:";
    preimage.append(round_date);
    assert!(round_id == sha2_256(preimage) &&
        registry::has_chart(reg, easy_chart_hash) &&
        registry::has_chart(reg, hard_chart_hash), EConfig);
    let started_at_ms = clock.timestamp_ms();
    let score_deadline_ms = started_at_ms + GAME_DURATION_MS;
    let claim_deadline_ms = score_deadline_ms + claim_window_ms;
    let id = object::new(ctx);
    let challenge = id.to_inner();
    let registry = object::id(reg);
    event::emit(ChallengeCreated {
        challenge, registry, round_date, round_id, easy_chart_hash, hard_chart_hash,
        started_at_ms, score_deadline_ms, claim_window_ms, claim_deadline_ms,
    });
    transfer::share_object(Challenge<T> {
        id, registry, round_date, round_id, easy_chart_hash, hard_chart_hash, device,
        started_at_ms, score_deadline_ms, claim_window_ms, claim_deadline_ms,
        pot: balance::zero(), buyers: table::new(ctx), attempts: table::new(ctx),
        claims: table::new(ctx), nullifiers: table::new(ctx),
        easy_top: vector[], hard_top: vector[], score_order: 0,
        total_purchases: 0, refund_purchases_remaining: 0,
        original_pot: 0, refund_pool: 0, settled: false,
    });
    IdentityCap { id: object::new(ctx), challenge }
}

/// Exactly one canonical six-decimal USDC buys three plays for the sender, on either
/// difficulty. No World identity, organizer relay or refundable interruption.
public fun buy_plays<T>(c: &mut Challenge<T>, payment: Coin<T>, clock: &Clock, ctx: &TxContext) {
    assert!(clock.timestamp_ms() < c.score_deadline_ms, EClosed);
    assert!(coin::value(&payment) == PRICE, EPrice);
    let wallet = ctx.sender();
    if (!c.buyers.contains(wallet)) {
        c.buyers.add(wallet, Buyer {
            plays: 0, purchases: 0, refunded: false,
            best_easy: option::none(), best_hard: option::none(),
        });
    };
    let buyer = c.buyers.borrow_mut(wallet);
    buyer.plays = buyer.plays + PLAYS_PER_PURCHASE;
    buyer.purchases = buyer.purchases + 1;
    let remaining_plays = buyer.plays;
    c.total_purchases = c.total_purchases + 1;
    balance::join(&mut c.pot, coin::into_balance(payment));
    event::emit(PlaysPurchased { challenge: object::id(c), wallet, remaining_plays });
}

/// The selected chart and one consumed wallet credit are bound to a fresh hardware
/// mode-3 native registry Session in the SAME atomic transaction.
public fun start_paid<T>(
    c: &mut Challenge<T>,
    reg: &Registry,
    difficulty: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(clock.timestamp_ms() < c.score_deadline_ms, EClosed);
    assert!(c.registry == object::id(reg), ERegistry);
    let chart_hash = chart_for(c, difficulty);
    let wallet = ctx.sender();
    assert!(c.buyers.contains(wallet), ENoPlays);
    let buyer = c.buyers.borrow_mut(wallet);
    assert!(buyer.plays > 0, ENoPlays);
    buyer.plays = buyer.plays - 1;
    let remaining_plays = buyer.plays;
    // Registry's inclusive expiry aligns with this vault's exclusive six-hour cutoff.
    let session = registry::open_competition_session(
        reg, c.round_id, chart_hash, wallet, c.device, c.score_deadline_ms - 1, clock, ctx,
    );
    c.attempts.add(session, Attempt { wallet, difficulty, recorded: false });
    event::emit(PaidAttemptStarted {
        challenge: object::id(c), session, wallet, difficulty, remaining_plays,
    });
    session
}

/// Only a consumed native GKR score on this original paid Session/chart/difficulty
/// counts. Anyone can relay; accepted recordings are immutable and replay-protected.
public fun record_score<T>(c: &mut Challenge<T>, session: &Session, clock: &Clock) {
    assert!(clock.timestamp_ms() < c.score_deadline_ms, EClosed);
    let sid = object::id(session);
    assert!(c.attempts.contains(sid), EAttempt);
    let attempt = c.attempts.borrow(sid);
    assert!(!attempt.recorded && registry::consumed(session), EScore);
    let wallet = attempt.wallet;
    let difficulty = attempt.difficulty;
    let chart_hash = chart_for(c, difficulty);
    assert!(registry::session_matches(
        session, c.registry, wallet, c.round_id, chart_hash, c.device, 3,
    ), EAttempt);
    c.attempts.borrow_mut(sid).recorded = true;
    let score = registry::session_score(session);
    c.score_order = c.score_order + 1;
    let candidate = Best { score, session: sid, order: c.score_order };
    let buyer = c.buyers.borrow_mut(wallet);
    let personal_best = if (difficulty == EASY) {
        if (buyer.best_easy.is_none() || score > buyer.best_easy.borrow().score) {
            buyer.best_easy = option::some(candidate);
            true
        } else false
    } else if (buyer.best_hard.is_none() || score > buyer.best_hard.borrow().score) {
        buyer.best_hard = option::some(candidate);
        true
    } else false;
    event::emit(PaidScoreRecorded {
        challenge: object::id(c), session: sid, wallet, difficulty, score, personal_best,
    });
}

fun outranks(a: &RankedClaim, b: &RankedClaim): bool {
    a.score > b.score || (a.score == b.score && a.order < b.order)
}

/// Constant-size insertion into one chart's provisional top five; every wallet
/// can register only ONCE across both charts and every nullifier only once overall.
fun insert_rank(top: &mut vector<RankedClaim>, candidate: RankedClaim): u64 {
    let mut updated = vector[];
    let mut inserted = false;
    let mut i = 0;
    while (i < top.length()) {
        let current = top[i];
        if (!inserted && outranks(&candidate, &current)) {
            updated.push_back(candidate);
            inserted = true;
        };
        if (updated.length() < 5) updated.push_back(current);
        i = i + 1;
    };
    if (!inserted && updated.length() < 5) updated.push_back(candidate);
    *top = updated;
    let mut rank = 0;
    let mut j = 0;
    while (j < top.length()) {
        if (top[j].wallet == candidate.wallet) rank = j + 1;
        j = j + 1;
    };
    rank
}

/// The service verifies World PoH and wallet signature OFF-chain after the six-hour
/// game ends. The nullifier must be round-scoped, 32 bytes, and never raw World ID.
/// No caller supplies a score: the highest native recorded score of the selected
/// difficulty is used. Claim arrival order never changes tie precedence.
public fun register_claim<T>(
    c: &mut Challenge<T>,
    cap: &IdentityCap,
    wallet: address,
    difficulty: u8,
    nullifier: vector<u8>,
    clock: &Clock,
) {
    assert!(cap.challenge == object::id(c) && nullifier.length() == 32, EIdentity);
    assert!(difficulty == EASY || difficulty == HARD, EDifficulty);
    let now = clock.timestamp_ms();
    assert!(now >= c.score_deadline_ms && now < c.claim_deadline_ms, EClosed);
    assert!(c.buyers.contains(wallet), EScore);
    let buyer = c.buyers.borrow(wallet);
    let best = if (difficulty == EASY) &buyer.best_easy else &buyer.best_hard;
    assert!(best.is_some(), EScore);
    if (c.claims.contains(wallet)) {
        let prior = c.claims.borrow(wallet);
        assert!(prior.nullifier == nullifier && prior.difficulty == difficulty &&
            c.nullifiers.contains(nullifier) && c.nullifiers[nullifier] == wallet, EIdentity);
        return
    };
    assert!(!c.nullifiers.contains(nullifier), EIdentity);
    let score = *best.borrow();
    let candidate = RankedClaim {
        wallet, session: score.session, score: score.score, order: score.order,
    };
    c.claims.add(wallet, ClaimBinding { nullifier, difficulty });
    c.nullifiers.add(nullifier, wallet);
    let provisional_rank = if (difficulty == EASY) {
        insert_rank(&mut c.easy_top, candidate)
    } else insert_rank(&mut c.hard_top, candidate);
    event::emit(ClaimRegistered {
        challenge: object::id(c), wallet, difficulty, nullifier,
        session: candidate.session, score: candidate.score, provisional_rank,
    });
}

fun share_percent(rank: u64): u64 {
    if (rank == 0) 40 else if (rank < 3) 20 else 10
}

/// Pays the finalized sorted ranks of one difficulty. Multiply in u128 BEFORE
/// dividing so payout never overflows or concentrates missing slots on a winner.
fun pay_ranked<T>(
    c: &mut Challenge<T>,
    difficulty: u8,
    original_pot: u64,
    ctx: &mut TxContext,
): u64 {
    let mut paid = 0;
    let len = if (difficulty == EASY) c.easy_top.length() else c.hard_top.length();
    let slice_percent: u64 = if (difficulty == EASY) 30 else 70;
    let mut i = 0;
    while (i < len) {
        let claim = if (difficulty == EASY) c.easy_top[i] else c.hard_top[i];
        let share_percent = share_percent(i);
        let amount = (((original_pot as u128) * (slice_percent as u128) *
            (share_percent as u128)) / 10_000) as u64;
        paid = paid + amount;
        if (amount > 0) {
            let prize = coin::from_balance(balance::split(&mut c.pot, amount), ctx);
            transfer::public_transfer(prize, claim.wallet);
        };
        event::emit(PrizePaid {
            challenge: object::id(c), wallet: claim.wallet, difficulty,
            session: claim.session, rank: i + 1,
            slice_percent, share_percent, amount,
        });
        i = i + 1;
    };
    paid
}

/// Permissionless payout after the full, immutable claim window. Easy gets 30%,
/// Hard 70% of the SAME original pot; each slice's ranks receive 40/20/20/10/10.
/// Unoccupied ranks and rounding remain in the vault for purchaser refunds.
public fun settle<T>(c: &mut Challenge<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(clock.timestamp_ms() >= c.claim_deadline_ms, EClosed);
    assert!(!c.settled, ESettlement);
    c.settled = true;
    let original_pot = balance::value(&c.pot);
    c.original_pot = original_pot;
    c.refund_purchases_remaining = c.total_purchases;
    let paid_prizes = pay_ranked(c, EASY, original_pot, ctx) +
        pay_ranked(c, HARD, original_pot, ctx);
    c.refund_pool = original_pot - paid_prizes;
    event::emit(ChallengeSettled {
        challenge: object::id(c), original_pot, paid_prizes,
        refund_pool: c.refund_pool,
        easy_winner_count: c.easy_top.length(), hard_winner_count: c.hard_top.length(),
    });
}

/// Refunds EVERY buyer their pro-rata share of vacant prizes, irrespective of
/// their own verified claim. Anyone can trigger a refund straight to that wallet.
/// Last buyer gets integer division dust; no expiry or operator sweep.
public fun refund<T>(c: &mut Challenge<T>, wallet: address, clock: &Clock, ctx: &mut TxContext) {
    assert!(c.settled && clock.timestamp_ms() >= c.claim_deadline_ms, ERefund);
    assert!(c.buyers.contains(wallet), ENotBuyer);
    let buyer = c.buyers.borrow_mut(wallet);
    assert!(!buyer.refunded && buyer.purchases > 0, ERefund);
    let purchases = buyer.purchases;
    buyer.refunded = true;
    c.refund_purchases_remaining = c.refund_purchases_remaining - purchases;
    let amount = if (c.refund_purchases_remaining == 0) balance::value(&c.pot) else {
        (((c.refund_pool as u128) * (purchases as u128)) / (c.total_purchases as u128)) as u64
    };
    if (amount > 0) {
        let payment = coin::from_balance(balance::split(&mut c.pot, amount), ctx);
        transfer::public_transfer(payment, wallet);
    };
    event::emit(EntryRefunded { challenge: object::id(c), wallet, amount });
}

public fun remaining_plays<T>(c: &Challenge<T>, wallet: address): u64 {
    if (!c.buyers.contains(wallet)) return 0;
    c.buyers[wallet].plays
}

public fun claim_registered<T>(c: &Challenge<T>, wallet: address): bool { c.claims.contains(wallet) }

public fun ranked_wallet<T>(c: &Challenge<T>, difficulty: u8, rank: u64): address {
    assert!(difficulty == EASY || difficulty == HARD, EDifficulty);
    let top = if (difficulty == EASY) &c.easy_top else &c.hard_top;
    assert!(rank > 0 && rank <= top.length(), ESettlement);
    top[rank - 1].wallet
}

public fun pot_value<T>(c: &Challenge<T>): u64 { balance::value(&c.pot) }

public fun refund_eligible<T>(c: &Challenge<T>, wallet: address): bool {
    if (!c.settled || c.refund_pool == 0 || !c.buyers.contains(wallet)) return false;
    let buyer = c.buyers.borrow(wallet);
    buyer.purchases > 0 && !buyer.refunded
}

public fun attempt_recorded<T>(c: &Challenge<T>, session: ID): bool {
    c.attempts.contains(session) && c.attempts[session].recorded
}
