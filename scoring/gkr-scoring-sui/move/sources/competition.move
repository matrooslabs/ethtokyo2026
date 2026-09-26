/// Paid competition: organizer selects the canonical USDC coin type T at creation.
/// Every successful purchase deposits exactly 1_000_000 units (six decimals) and grants
/// three non-refundable play starts. A start and its native registry session are atomic.
/// The trusted IdentityCap operator must independently verify World ID with the round's
/// external nullifier and wallet ownership before attesting a (wallet, nullifier) pair.
module mania_gkr::competition;

use mania_gkr::registry::{Self, OrganizerCap, Registry, Session};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

const PRICE: u64 = 1_000_000;
const PLAYS_PER_PURCHASE: u64 = 3;

const EConfig: u64 = 0;
const EIdentity: u64 = 1;
const ENotRegistered: u64 = 2;
const EPrice: u64 = 3;
const EClosed: u64 = 4;
const ENoPlays: u64 = 5;
const ERegistry: u64 = 6;
const EAttempt: u64 = 7;
const EScore: u64 = 8;
const EPrize: u64 = 9;
const ERefund: u64 = 10;

public struct Competition<phantom T> has key {
    id: UID,
    registry: ID,
    round_id: vector<u8>,
    chart_hash: vector<u8>,
    device: vector<u8>,
    sales_deadline_ms: u64,
    starts_deadline_ms: u64,
    score_deadline_ms: u64,
    claim_deadline_ms: u64,
    pot: Balance<T>,
    wallets: Table<address, vector<u8>>,
    people: Table<vector<u8>, Participant>,
    attempts: Table<ID, Attempt>,
    has_winner: bool,
    winner: address,
    winning_session: Option<ID>,
    high_score: u64,
    prize_paid: bool,
}

/// Transfer this object only to the trusted World ID verification service's Sui wallet.
public struct IdentityCap has key, store {
    id: UID,
    competition: ID,
}

public struct Participant has store {
    wallet: address,
    plays: u64,
    purchases: u64,
    refunded: bool,
}

public struct Attempt has store {
    wallet: address,
    nullifier: vector<u8>,
    recorded: bool,
}

public struct CompetitionCreated has copy, drop {
    competition: ID,
    registry: ID,
    round_id: vector<u8>,
    chart_hash: vector<u8>,
    sales_deadline_ms: u64,
    starts_deadline_ms: u64,
    score_deadline_ms: u64,
    claim_deadline_ms: u64,
}

public struct IdentityBound has copy, drop {
    competition: ID,
    wallet: address,
    nullifier: vector<u8>,
}

public struct PlaysPurchased has copy, drop {
    competition: ID,
    wallet: address,
    remaining_plays: u64,
}

public struct PaidAttemptStarted has copy, drop {
    competition: ID,
    session: ID,
    wallet: address,
    remaining_plays: u64,
}

public struct PaidScoreRecorded has copy, drop {
    competition: ID,
    session: ID,
    wallet: address,
    score: u64,
    is_leader: bool,
}

public struct PrizePaid has copy, drop {
    competition: ID,
    winner: address,
    session: ID,
    amount: u64,
}

public struct EntryRefunded has copy, drop {
    competition: ID,
    wallet: address,
    amount: u64,
}

/// Dates are absolute Sui Clock milliseconds. Tie-break: earliest score recorded on-chain
/// wins (strictly higher score replaces the leader). A verified zero is a valid winner.
public fun create<T>(
    reg: &Registry,
    organizer: &OrganizerCap,
    round_id: vector<u8>,
    chart_hash: vector<u8>,
    device: vector<u8>,
    sales_deadline_ms: u64,
    starts_deadline_ms: u64,
    score_deadline_ms: u64,
    claim_deadline_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): IdentityCap {
    registry::assert_organizer(reg, organizer);
    assert!(round_id.length() == 32 && chart_hash.length() == 32 && device.length() == 20, EConfig);
    assert!(registry::has_chart(reg, chart_hash), EConfig);
    assert!(clock.timestamp_ms() < sales_deadline_ms &&
        sales_deadline_ms <= starts_deadline_ms &&
        starts_deadline_ms < score_deadline_ms &&
        score_deadline_ms < claim_deadline_ms, EConfig);
    let id = object::new(ctx);
    let competition = id.to_inner();
    let registry = object::id(reg);
    event::emit(CompetitionCreated {
        competition, registry, round_id, chart_hash,
        sales_deadline_ms, starts_deadline_ms, score_deadline_ms, claim_deadline_ms,
    });
    transfer::share_object(Competition<T> {
        id, registry, round_id, chart_hash, device,
        sales_deadline_ms, starts_deadline_ms, score_deadline_ms, claim_deadline_ms,
        pot: balance::zero(), wallets: table::new(ctx), people: table::new(ctx),
        attempts: table::new(ctx), has_winner: false, winner: @0x0,
        winning_session: option::none(), high_score: 0, prize_paid: false,
    });
    IdentityCap { id: object::new(ctx), competition }
}

/// Only the capability holder can attest; proof verification is OFF-chain. Re-attesting
/// the exact same binding is idempotent, but a nullifier or wallet cannot change owners.
public fun attest_identity<T>(
    c: &mut Competition<T>,
    cap: &IdentityCap,
    wallet: address,
    nullifier: vector<u8>,
) {
    assert!(cap.competition == object::id(c) && nullifier.length() == 32, EIdentity);
    if (c.wallets.contains(wallet)) {
        assert!(c.wallets[wallet] == nullifier, EIdentity);
        assert!(c.people.contains(nullifier) && c.people[nullifier].wallet == wallet, EIdentity);
        return
    };
    assert!(!c.people.contains(nullifier), EIdentity);
    c.wallets.add(wallet, nullifier);
    c.people.add(nullifier, Participant { wallet, plays: 0, purchases: 0, refunded: false });
    event::emit(IdentityBound { competition: object::id(c), wallet, nullifier });
}

/// Accepts exactly one six-decimal USDC; no change or arbitrary caller-supplied price.
public fun buy_plays<T>(c: &mut Competition<T>, payment: Coin<T>, clock: &Clock, ctx: &TxContext) {
    assert!(clock.timestamp_ms() < c.sales_deadline_ms, EClosed);
    let wallet = ctx.sender();
    assert!(c.wallets.contains(wallet), ENotRegistered);
    assert!(coin::value(&payment) == PRICE, EPrice);
    let nullifier = c.wallets[wallet];
    let person = c.people.borrow_mut(nullifier);
    person.plays = person.plays + PLAYS_PER_PURCHASE;
    person.purchases = person.purchases + 1;
    let remaining_plays = person.plays;
    balance::join(&mut c.pot, coin::into_balance(payment));
    event::emit(PlaysPurchased { competition: object::id(c), wallet, remaining_plays });
}

/// Non-resumable paid attempt: immediately burns a credit even if the client disconnects,
/// its device fails, the proof is never submitted or the session times out.
public fun start_paid<T>(
    c: &mut Competition<T>,
    reg: &Registry,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(clock.timestamp_ms() < c.starts_deadline_ms, EClosed);
    assert!(c.registry == object::id(reg), ERegistry);
    let wallet = ctx.sender();
    assert!(c.wallets.contains(wallet), ENotRegistered);
    let nullifier = c.wallets[wallet];
    let person = c.people.borrow_mut(nullifier);
    assert!(person.plays > 0, ENoPlays);
    person.plays = person.plays - 1;
    let remaining_plays = person.plays;
    let session = registry::open_competition_session(
        reg, c.round_id, c.chart_hash, wallet, c.device, c.score_deadline_ms, clock, ctx,
    );
    c.attempts.add(session, Attempt { wallet, nullifier, recorded: false });
    event::emit(PaidAttemptStarted { competition: object::id(c), session, wallet, remaining_plays });
    session
}

/// A native verifier must first consume exactly this paid session. Relayers may call this,
/// but only before the score cutoff, so final winner cannot change after settlement begins.
public fun record_score<T>(c: &mut Competition<T>, session: &Session, clock: &Clock) {
    assert!(clock.timestamp_ms() <= c.score_deadline_ms, EClosed);
    let sid = object::id(session);
    assert!(c.attempts.contains(sid), EAttempt);
    let attempt = c.attempts.borrow_mut(sid);
    assert!(!attempt.recorded && registry::consumed(session), EScore);
    assert!(registry::session_matches(
        session, c.registry, attempt.wallet, c.round_id, c.chart_hash, c.device, 3,
    ), EAttempt);
    assert!(c.people[attempt.nullifier].wallet == attempt.wallet, EAttempt);
    attempt.recorded = true;
    let wallet = attempt.wallet;
    let score = registry::session_score(session);
    let is_leader = !c.has_winner || score > c.high_score;
    if (is_leader) {
        c.has_winner = true;
        c.winner = wallet;
        c.winning_session = option::some(sid);
        c.high_score = score;
    };
    event::emit(PaidScoreRecorded {
        competition: object::id(c), session: sid, wallet, score, is_leader,
    });
}

/// Permissionless payout directly to the verified winning wallet. No operator can
/// override the on-chain score or substitute a destination. Exactly one payout.
public fun claim_prize<T>(c: &mut Competition<T>, clock: &Clock, ctx: &mut TxContext) {
    let now = clock.timestamp_ms();
    assert!(now > c.score_deadline_ms && now <= c.claim_deadline_ms, EClosed);
    assert!(c.has_winner && !c.prize_paid, EPrize);
    c.prize_paid = true;
    let amount = balance::value(&c.pot);
    let coin = coin::from_balance(balance::split(&mut c.pot, amount), ctx);
    transfer::public_transfer(coin, c.winner);
    event::emit(PrizePaid {
        competition: object::id(c), winner: c.winner,
        session: *c.winning_session.borrow(), amount,
    });
}

/// Honest no-winner policy: if no verified score was recorded by score cutoff, every
/// buyer may reclaim ALL purchases (including used credits). If a winner was recorded
/// but not paid by claim cutoff, exactly the same refund policy applies. No organizer
/// sweep; refunds have no expiration and can be triggered by anyone for that wallet.
public fun refund<T>(c: &mut Competition<T>, wallet: address, clock: &Clock, ctx: &mut TxContext) {
    assert!(clock.timestamp_ms() > c.score_deadline_ms &&
        (!c.has_winner || clock.timestamp_ms() > c.claim_deadline_ms) &&
        !c.prize_paid, ERefund);
    assert!(c.wallets.contains(wallet), ENotRegistered);
    let nullifier = c.wallets[wallet];
    let person = c.people.borrow_mut(nullifier);
    assert!(!person.refunded && person.purchases > 0, ERefund);
    let amount = person.purchases * PRICE;
    person.refunded = true;
    let coin = coin::from_balance(balance::split(&mut c.pot, amount), ctx);
    transfer::public_transfer(coin, wallet);
    event::emit(EntryRefunded { competition: object::id(c), wallet, amount });
}

public fun remaining_plays<T>(c: &Competition<T>, wallet: address): u64 {
    if (!c.wallets.contains(wallet)) return 0;
    c.people[c.wallets[wallet]].plays
}

public fun leader<T>(c: &Competition<T>): (bool, address, u64) {
    (c.has_winner, c.winner, c.high_score)
}

public fun pot_value<T>(c: &Competition<T>): u64 { balance::value(&c.pot) }

public fun attempt_recorded<T>(c: &Competition<T>, session: ID): bool {
    c.attempts.contains(session) && c.attempts[session].recorded
}
