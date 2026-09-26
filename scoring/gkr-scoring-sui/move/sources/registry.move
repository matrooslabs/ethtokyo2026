/// Devices, charts, sessions and score recording (SPEC §8.2), mirroring the EVM
/// `ManiaGkrRegistry`. The device protocol is unchanged: the SE050 signs the SHA-256
/// session digest with secp256k1 (r ‖ s ‖ v), and mode A uses the V1 digest verbatim.
module mania_gkr::registry;

use mania_gkr::chart::{Self, ChartCheck};
use mania_gkr::fr;
use mania_gkr::verifier::{Self, ChartRecord};
use mania_gkr::zeromorph::{Self, VerifierKey};
use std::hash::sha2_256;
use sui::bcs;
use sui::clock::Clock;
use sui::ecdsa_k1;
use sui::bls12381::Scalar;
use sui::event;
use sui::group_ops::Element;
use sui::hash::keccak256;
use sui::table::{Self, Table};

const RULESET_NAME: vector<u8> = b"OSUMANIA_ONCHAIN_RULESET_V1";
const INPUT_POLICY_A: vector<u8> = b"OSUMANIA_INPUT_POLICY_V1";
const INPUT_POLICY_B: vector<u8> = b"OSUMANIA_INPUT_POLICY_V2_KZG_BLS12381";
const SESSION_DOMAIN_V1: vector<u8> = b"OSUMANIA_HARDWARE_SESSION_V1";
const SESSION_DOMAIN_V2: vector<u8> = b"OSUMANIA_HARDWARE_SESSION_V2_BLS12381";
const TRACE_DOMAIN: vector<u8> = b"OSUMANIA_TRACE_V1";
const MODE_CALLDATA: u8 = 1;
const MODE_COMMITTED: u8 = 2;
const MAX_EVENTS: u64 = 50_000;
const EVENT_BYTES: u64 = 14;
const CHUNK_EVENTS: u64 = 32;
/// secp256k1 n / 2 (low-s rule).
const HALF_ORDER: u256 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
const SHA256: u8 = 1;

const EWrongRegistry: u64 = 1;
const EInvalidDevice: u64 = 2;
const EChartExists: u64 = 3;
const EInvalidSession: u64 = 4;
const EConsumed: u64 = 5;
const EWrongMode: u64 = 6;
const EExpired: u64 = 7;
const EWrongDomain: u64 = 8;
const EDeviceRevoked: u64 = 9;
const ESignature: u64 = 10;
const ETraceEncoding: u64 = 11;
const ETooManyEvents: u64 = 12;
const EChartState: u64 = 13;
const ETraceClosed: u64 = 14;
const EWrongSession: u64 = 15;

public struct Registry has key {
    id: UID,
    vk: VerifierKey,
    chain_id: u64,
    /// 20-byte `verifier` header field: keccak256(registry id)[12..].
    verifier_tag: vector<u8>,
    /// Keyed by the 20-byte EVM-style device address.
    devices: Table<vector<u8>, Device>,
    /// Keyed by chartHash.
    charts: Table<vector<u8>, ChartRecord>,
}

public struct OrganizerCap has key, store {
    id: UID,
    registry: ID,
}

public struct Device has copy, drop, store {
    pubkey: vector<u8>,
    bitstream_hash: vector<u8>,
    active: bool,
}

/// SP1 V1 session header; 20-byte fields keep the hardware digest format unchanged.
public struct Header has copy, drop, store {
    chain_id: u64,
    verifier: vector<u8>,
    match_id: vector<u8>,
    session_id: vector<u8>,
    challenge: vector<u8>,
    player: vector<u8>,
    device: vector<u8>,
    chart_hash: vector<u8>,
    ruleset_id: vector<u8>,
    bitstream_hash: vector<u8>,
    input_policy_hash: vector<u8>,
}

public struct Session has key {
    id: UID,
    registry: ID,
    header: Header,
    player: address,
    mode: u8,
    expires_at_ms: u64,
    consumed: bool,
    score: u64,
    judgements: vector<u64>,
}

/// Staging object for chart registration: bytes may arrive over several transactions
/// (up to 170 KB) and the per-note check can be resumed across transactions.
public struct ChartUpload has key, store {
    id: UID,
    bytes: vector<u8>,
    check: Option<ChartCheck>,
}

/// Mode-A trace staging: the device's chunks of ≤32 events (14 bytes each) are appended,
/// possibly over several transactions. Appending recomputes the SHA-256 chain, enforces
/// seq == index, and keeps what the verifier needs: timestamps as scalars and lane/action
/// codes (object size caps mode A at ~7,000 events; mode B has no such limit).
public struct TraceUpload has key, store {
    id: UID,
    session: ID,
    root: vector<u8>,
    n: u64,
    chunks: u64,
    closed: bool,
    t: vector<Element<Scalar>>,
    /// lane | act << 2
    la: vector<u8>,
}

public struct ChartRegistered has copy, drop {
    chart_hash: vector<u8>,
    notes: u64,
    components: u64,
}

public struct SessionOpened has copy, drop {
    session: ID,
    player: address,
    device: vector<u8>,
    mode: u8,
}

public struct ScoreAccepted has copy, drop {
    session: ID,
    player: address,
    score: u64,
    judgements: vector<u64>,
}

fun tail20(h: vector<u8>): vector<u8> {
    let mut out = vector[];
    let mut i = 12;
    while (i < 32) {
        out.push_back(h[i]);
        i = i + 1;
    };
    out
}

/// keccak256(X ‖ Y)[12..] of a compressed secp256k1 key: the EVM address of the device.
public fun device_address(pubkey: &vector<u8>): vector<u8> {
    let full = ecdsa_k1::decompress_pubkey(pubkey);
    let mut xy = vector[];
    let mut i = 1;
    while (i < 65) {
        xy.push_back(full[i]);
        i = i + 1;
    };
    tail20(keccak256(&xy))
}

/// 20-byte header encoding of a Sui address: keccak256(address)[12..].
public fun address20(a: address): vector<u8> { tail20(keccak256(&bcs::to_bytes(&a))) }

// ------------------------------------------------------------------ setup

fun new_registry(
    g2_tau: vector<u8>,
    g2_shift: vector<vector<u8>>,
    chain_id: u64,
    ctx: &mut TxContext,
): Registry {
    let id = object::new(ctx);
    let verifier_tag = tail20(keccak256(&id.to_bytes()));
    Registry {
        id,
        vk: zeromorph::new_vk(g2_tau, g2_shift),
        chain_id,
        verifier_tag,
        devices: table::new(ctx),
        charts: table::new(ctx),
    }
}

/// Shares a registry bound to the SRS G2 key and returns its organizer capability.
public fun create(
    g2_tau: vector<u8>,
    g2_shift: vector<vector<u8>>,
    chain_id: u64,
    ctx: &mut TxContext,
): OrganizerCap {
    let reg = new_registry(g2_tau, g2_shift, chain_id, ctx);
    let cap = OrganizerCap { id: object::new(ctx), registry: object::id(&reg) };
    transfer::share_object(reg);
    cap
}

fun check_cap(reg: &Registry, cap: &OrganizerCap) {
    assert!(cap.registry == object::id(reg), EWrongRegistry);
}

public fun set_device(
    reg: &mut Registry,
    cap: &OrganizerCap,
    pubkey: vector<u8>,
    bitstream_hash: vector<u8>,
    active: bool,
) {
    check_cap(reg, cap);
    assert!(pubkey.length() == 33 && bitstream_hash.length() == 32, EInvalidDevice);
    let addr = device_address(&pubkey);
    if (reg.devices.contains(addr)) {
        reg.devices.remove(addr);
    };
    reg.devices.add(addr, Device { pubkey, bitstream_hash, active });
}

public fun new_chart_upload(ctx: &mut TxContext): ChartUpload {
    ChartUpload { id: object::new(ctx), bytes: vector[], check: option::none() }
}

public fun append_chart(upload: &mut ChartUpload, chunk: vector<u8>) {
    assert!(upload.check.is_none(), EChartState);
    upload.bytes.append(chunk)
}

/// Freezes the bytes: header checks, chartHash, and the opening point for `commitment`.
public fun begin_chart(reg: &Registry, upload: &mut ChartUpload, commitment: vector<u8>) {
    assert!(upload.check.is_none(), EChartState);
    upload.check.fill(chart::begin(&reg.vk, &upload.bytes, commitment));
}

/// Validates up to `max_notes` further notes (repeat in later transactions for big charts).
public fun process_chart(upload: &mut ChartUpload, max_notes: u64) {
    assert!(upload.check.is_some(), EChartState);
    chart::process(upload.check.borrow_mut(), &upload.bytes, max_notes);
}

public fun chart_done(upload: &ChartUpload): bool {
    upload.check.is_some() && chart::done(upload.check.borrow())
}

/// Finishes the on-chain chart check (SPEC §8.1) and records the chart.
public fun register_chart(
    reg: &mut Registry,
    cap: &OrganizerCap,
    upload: ChartUpload,
    proof: vector<vector<vector<u8>>>,
): vector<u8> {
    check_cap(reg, cap);
    let ChartUpload { id, bytes: _, check } = upload;
    id.delete();
    assert!(check.is_some(), EChartState);
    let (chart_hash, record) = chart::finish(check.destroy_some(), &reg.vk, proof);
    assert!(!reg.charts.contains(chart_hash), EChartExists);
    event::emit(ChartRegistered {
        chart_hash,
        notes: verifier::chart_m(&record),
        components: verifier::chart_components(&record),
    });
    reg.charts.add(chart_hash, record);
    chart_hash
}

public fun open_session(
    reg: &Registry,
    cap: &OrganizerCap,
    match_id: vector<u8>,
    chart_hash: vector<u8>,
    player: address,
    device: vector<u8>,
    expires_at_ms: u64,
    mode: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    check_cap(reg, cap);
    assert!(match_id.length() == 32, EInvalidSession);
    assert!(reg.devices.contains(device) && reg.devices[device].active, EInvalidDevice);
    assert!(reg.charts.contains(chart_hash) && expires_at_ms > clock.timestamp_ms(), EInvalidSession);
    assert!(mode == MODE_CALLDATA || mode == MODE_COMMITTED, EWrongMode);
    let id = object::new(ctx);
    let session_id = id.to_bytes();
    let mut seed = session_id;
    seed.append(*ctx.digest());
    seed.append(bcs::to_bytes(&clock.timestamp_ms()));
    let header = Header {
        chain_id: reg.chain_id,
        verifier: reg.verifier_tag,
        match_id,
        session_id,
        challenge: keccak256(&seed),
        player: address20(player),
        device,
        chart_hash,
        ruleset_id: sha2_256(RULESET_NAME),
        bitstream_hash: reg.devices[device].bitstream_hash,
        input_policy_hash: sha2_256(if (mode == MODE_CALLDATA) INPUT_POLICY_A else INPUT_POLICY_B),
    };
    let sid = id.to_inner();
    event::emit(SessionOpened { session: sid, player, device, mode });
    transfer::share_object(Session {
        id,
        registry: object::id(reg),
        header,
        player,
        mode,
        expires_at_ms,
        consumed: false,
        score: 0,
        judgements: vector[],
    });
    sid
}

// ------------------------------------------------------------------ digests

fun push_be(out: &mut vector<u8>, x: u64, bytes: u64) {
    let mut i = bytes;
    while (i > 0) {
        i = i - 1;
        out.push_back(((x >> ((8 * i) as u8)) & 0xff) as u8);
    };
}

fun header_prefix(h: &Header): vector<u8> {
    let mut b = vector[];
    push_be(&mut b, h.chain_id, 8);
    b.append(h.verifier);
    b.append(h.match_id);
    b.append(h.session_id);
    b.append(h.challenge);
    b.append(h.player);
    b.append(h.device);
    b.append(h.chart_hash);
    b.append(h.ruleset_id);
    b.append(h.bitstream_hash);
    b.append(h.input_policy_hash);
    b
}

/// Preimage of the SP1 V1 session digest (unchanged hardware protocol).
public fun digest_preimage_v1(h: &Header, n: u64, duration: u64, root: vector<u8>): vector<u8> {
    let mut b = SESSION_DOMAIN_V1;
    push_be(&mut b, 1, 2);
    b.append(header_prefix(h));
    push_be(&mut b, n, 4);
    push_be(&mut b, duration, 8);
    b.append(root);
    b
}

/// Preimage of the mode-B digest: V1 fields plus the device's BLS12-381 trace commitment.
public fun digest_preimage_v2(
    h: &Header,
    n: u64,
    duration: u64,
    root: vector<u8>,
    trace_commitment: vector<u8>,
): vector<u8> {
    let mut b = SESSION_DOMAIN_V2;
    push_be(&mut b, 2, 2);
    b.append(header_prefix(h));
    push_be(&mut b, n, 4);
    push_be(&mut b, duration, 8);
    b.append(root);
    b.append(trace_commitment);
    b
}

/// Starts the SP1 trace chain: root = sha256("OSUMANIA_TRACE_V1" ‖ sessionId).
public fun new_trace_upload(session: &Session, ctx: &mut TxContext): TraceUpload {
    let mut seed = TRACE_DOMAIN;
    seed.append(session.header.session_id);
    TraceUpload {
        id: object::new(ctx),
        session: object::id(session),
        root: sha2_256(seed),
        n: 0,
        chunks: 0,
        closed: false,
        t: vector[],
        la: vector[],
    }
}

/// Appends device chunks: root = sha256(root ‖ u32 index ‖ u16 count ‖ events). Every chunk
/// but the last has exactly 32 events; seq must equal the global event index.
public fun append_trace(up: &mut TraceUpload, chunks: vector<vector<u8>>) {
    chunks.do!(|c| {
        assert!(!up.closed, ETraceClosed);
        let len = c.length();
        let count = len / EVENT_BYTES;
        assert!(len % EVENT_BYTES == 0 && count >= 1 && count <= CHUNK_EVENTS, ETraceEncoding);
        assert!(up.n + count <= MAX_EVENTS, ETooManyEvents);
        if (count < CHUNK_EVENTS) up.closed = true;
        let mut buf = up.root;
        push_be(&mut buf, up.chunks, 4);
        push_be(&mut buf, count, 2);
        let mut off = 0;
        while (off < len) {
            let seq = ((c[off] as u64) << 24) | ((c[off + 1] as u64) << 16) | ((c[off + 2] as u64) << 8) | (c[off + 3] as u64);
            assert!(seq == up.n, ETraceEncoding);
            let mut k = off;
            while (k < off + EVENT_BYTES) {
                buf.push_back(c[k]);
                k = k + 1;
            };
            let (t, _) = fr::from_be8(&c, off + 4);
            let (lane, act) = (c[off + 12], c[off + 13]);
            assert!(lane < 4 && act <= 1, ETraceEncoding);
            up.t.push_back(t);
            up.la.push_back(lane | (act << 2));
            up.n = up.n + 1;
            off = off + EVENT_BYTES;
        };
        up.root = sha2_256(buf);
        up.chunks = up.chunks + 1;
    });
}

public fun trace_root(up: &TraceUpload): vector<u8> { up.root }

public fun trace_len(up: &TraceUpload): u64 { up.n }

// ------------------------------------------------------------------ submission

fun check_open(reg: &Registry, s: &Session, mode: u8, clock: &Clock): Device {
    assert!(s.registry == object::id(reg), EWrongRegistry);
    assert!(!s.consumed, EConsumed);
    assert!(s.mode == mode, EWrongMode);
    assert!(clock.timestamp_ms() <= s.expires_at_ms, EExpired);
    assert!(s.header.chain_id == reg.chain_id && s.header.verifier == reg.verifier_tag, EWrongDomain);
    assert!(reg.devices.contains(s.header.device), EDeviceRevoked);
    let d = reg.devices[s.header.device];
    assert!(d.active && d.bitstream_hash == s.header.bitstream_hash, EDeviceRevoked);
    d
}

/// r ‖ s ‖ v with v ∈ {27, 28} and low s, over sha256(preimage) = sessionDigest.
fun check_signature(d: &Device, preimage: &vector<u8>, sig: &vector<u8>) {
    assert!(sig.length() == 65, ESignature);
    let v = sig[64];
    let mut rs = vector[];
    let mut i = 0;
    while (i < 64) {
        rs.push_back(sig[i]);
        i = i + 1;
    };
    let s = mania_gkr::fr::be_to_u256(&rs, 32);
    assert!((v == 27 || v == 28) && s <= HALF_ORDER, ESignature);
    assert!(ecdsa_k1::secp256k1_verify(&rs, &d.pubkey, preimage, SHA256), ESignature);
}

fun statement(
    reg: &Registry,
    s: &Session,
    digest: vector<u8>,
    n: u64,
    duration: u64,
    trace_commitment: vector<u8>,
    lane_bits: vector<u64>,
    counts: vector<u64>,
): verifier::Statement {
    verifier::new_statement(
        s.mode,
        digest,
        n,
        duration,
        reg.charts[s.header.chart_hash],
        trace_commitment,
        lane_bits,
        counts,
    )
}

fun record(s: &mut Session, v: &verifier::VerifiedScore) {
    s.consumed = true;
    s.score = verifier::score(v);
    s.judgements = verifier::judgements(v);
    event::emit(ScoreAccepted {
        session: object::id(s),
        player: s.player,
        score: s.score,
        judgements: s.judgements,
    });
}

/// Mode A: the full trace is posted on-chain (staged in a `TraceUpload`); anyone may relay.
public fun submit_calldata(
    reg: &Registry,
    session: &mut Session,
    trace: TraceUpload,
    duration: u64,
    lane_bits: vector<u64>,
    counts: vector<u64>,
    proof: vector<vector<vector<u8>>>,
    sig: vector<u8>,
    clock: &Clock,
): u64 {
    let d = check_open(reg, session, MODE_CALLDATA, clock);
    let TraceUpload { id, session: sid, root, n, chunks: _, closed: _, t, la } = trace;
    id.delete();
    assert!(sid == object::id(session), EWrongSession);
    let preimage = digest_preimage_v1(&session.header, n, duration, root);
    check_signature(&d, &preimage, &sig);
    let st = statement(reg, session, sha2_256(preimage), n, duration, vector[], lane_bits, counts);
    let v = verifier::verify(&reg.vk, &st, proof, &t, &la);
    record(session, &v);
    verifier::score(&v)
}

/// Mode B: the device signed a KZG commitment to the trace; the trace is not posted.
public fun submit_committed(
    reg: &Registry,
    session: &mut Session,
    n: u64,
    root: vector<u8>,
    trace_commitment: vector<u8>,
    duration: u64,
    lane_bits: vector<u64>,
    counts: vector<u64>,
    proof: vector<vector<vector<u8>>>,
    sig: vector<u8>,
    clock: &Clock,
): u64 {
    let d = check_open(reg, session, MODE_COMMITTED, clock);
    assert!(n <= MAX_EVENTS, ETooManyEvents);
    assert!(root.length() == 32 && trace_commitment.length() == 48, EInvalidSession);
    let preimage = digest_preimage_v2(&session.header, n, duration, root, trace_commitment);
    check_signature(&d, &preimage, &sig);
    let st = statement(reg, session, sha2_256(preimage), n, duration, trace_commitment, lane_bits, counts);
    let v = verifier::verify(&reg.vk, &st, proof, &vector[], &vector[]);
    record(session, &v);
    verifier::score(&v)
}

// ------------------------------------------------------------------ views

public fun vk(reg: &Registry): &VerifierKey { &reg.vk }

public fun chain_id(reg: &Registry): u64 { reg.chain_id }

public fun verifier_tag(reg: &Registry): vector<u8> { reg.verifier_tag }

public fun has_chart(reg: &Registry, chart_hash: vector<u8>): bool { reg.charts.contains(chart_hash) }

public fun header(s: &Session): &Header { &s.header }

public fun consumed(s: &Session): bool { s.consumed }

public fun session_score(s: &Session): u64 { s.score }

public fun session_judgements(s: &Session): vector<u64> { s.judgements }

// ------------------------------------------------------------------ tests

#[test_only]
public fun create_for_testing(
    g2_tau: vector<u8>,
    g2_shift: vector<vector<u8>>,
    chain_id: u64,
    verifier_tag: vector<u8>,
    ctx: &mut TxContext,
): OrganizerCap {
    let mut reg = new_registry(g2_tau, g2_shift, chain_id, ctx);
    reg.verifier_tag = verifier_tag;
    let cap = OrganizerCap { id: object::new(ctx), registry: object::id(&reg) };
    transfer::share_object(reg);
    cap
}

#[test_only]
public fun new_header_for_testing(
    chain_id: u64,
    verifier: vector<u8>,
    match_id: vector<u8>,
    session_id: vector<u8>,
    challenge: vector<u8>,
    player: vector<u8>,
    device: vector<u8>,
    chart_hash: vector<u8>,
    ruleset_id: vector<u8>,
    bitstream_hash: vector<u8>,
    input_policy_hash: vector<u8>,
): Header {
    Header {
        chain_id,
        verifier,
        match_id,
        session_id,
        challenge,
        player,
        device,
        chart_hash,
        ruleset_id,
        bitstream_hash,
        input_policy_hash,
    }
}

/// Records a chart without the on-chain check (unit tests share one gas meter per test, so
/// registration and submission are measured separately).
#[test_only]
public fun add_chart_for_testing(reg: &mut Registry, chart_hash: vector<u8>, record: ChartRecord) {
    reg.charts.add(chart_hash, record);
}

/// A staged trace with precomputed contents (see `add_chart_for_testing`).
#[test_only]
public fun trace_upload_for_testing(
    session: &Session,
    root: vector<u8>,
    t: vector<Element<Scalar>>,
    la: vector<u8>,
    ctx: &mut TxContext,
): TraceUpload {
    let n = t.length();
    TraceUpload { id: object::new(ctx), session: object::id(session), root, n, chunks: 0, closed: true, t, la }
}

/// A session with a caller-chosen header (fixtures are proven against fixed headers).
#[test_only]
public fun open_session_for_testing(
    reg: &Registry,
    header: Header,
    player: address,
    mode: u8,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    transfer::share_object(Session {
        id: object::new(ctx),
        registry: object::id(reg),
        header,
        player,
        mode,
        expires_at_ms,
        consumed: false,
        score: 0,
        judgements: vector[],
    });
}
