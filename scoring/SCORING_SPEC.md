> Maintained canonical V1 scoring and hardware format specification. The historical SP1 proof integration described below has been removed; current proof verification uses [GKR](gkr-scoring/SPEC.md), with shared semantics in [core](core/).

# OSUMANIA_ONCHAIN_RULESET_V1 (prototype)

This document and `core/src/lib.rs` define the tournament protocol. This is **not**
official osu!lazer score or full hold/notelock compatibility. Change the ruleset
identifier AND rebuild/redeploy the program verification key when changing semantics.
Changes to canonical encodings also require new protocol domains/versions.

## Inputs and bounds

- Four lanes, indexed 0..3; no mods, calibration offsets, rate adjustments, ticks,
  combo bonuses, health, or RNG. Time is an unsigned integer in microseconds from
  the controller's start; no wall clock enters scoring.
- 1..10,000 chart notes, at most 50,000 trace events, duration at most
  1,800,000,000 us (30 minutes). JSON arrays of bytes represent hashes/addresses.
- Notes are strictly sorted by `(start_us, lane)`. `start_us == end_us` means tap;
  `start_us < end_us` means hold. In one lane, each start must be strictly after
  the previous note's end (including taps). Other-lane simultaneity is allowed.
- Every note ends no later than `MAX_DURATION_US - 136500`. The recording duration
  must cover `max(note.end_us) + 136500`, including trailing silence.
- Events have zero-based consecutive sequence numbers, nondecreasing timestamps
  not exceeding duration, lane 0..3, action 0=DOWN or 1=UP. Equal timestamps execute
  in sequence order. Each lane starts UP; duplicate DOWN and unmatched UP invalidate
  the whole witness. A lane may remain DOWN at the recording end; no UP is invented.

## Judgements

| Result | Inclusive absolute timing error (us) | Points |
|---|---:|---:|
| PERFECT | 19,500 | 320 |
| GREAT | 49,500 | 300 |
| GOOD | 82,500 | 200 |
| OK | 112,500 | 100 |
| MEH | 136,500 | 50 |
| MISS | otherwise | 0 |

The first matching window wins. These five windows use the normal, no-mod OD5
`floor(window) + 0.5 ms` values from this repository's `ManiaHitWindows.cs`, at
commit `6408b4e0e46a9f4ea1b8d263afccd1df799604e4`. The official separate MISS
window and official hold/combination semantics are deliberately not imported.

Each lane has a queue of unjudged heads, an optional active hold tail, and a physical
key state. Before each event at `t` on that lane:

1. An active tail with `t > tail + 136500` becomes MISS and is cleared.
2. Every pending head with `t > head + 136500` becomes MISS. If it is a hold,
   its tail also becomes MISS. Advance the queue once for each expired note.

Then validate and apply the physical key transition:

- DOWN attempts only the earliest pending head in that lane. It does not search
  for the closest note or skip a still-open earlier note. If its absolute delta is
  at most 136500, consume that head and assign its judgement. For a hold, activate
  its tail. An earlier DOWN outside the window consumes no note and earns no points,
  but still puts the physical key in the DOWN state. Extra valid edges have no penalty.
- UP judges the active tail against its end time and clears it. The first release
  is final: an early/late release outside all windows is MISS, and re-grabbing cannot
  recover that tail. UP with no active tail only updates key state.
- At end, run expiration at `duration_us + 1` on all lanes, so an absent input at
  the exact inclusive last boundary is still counted as a miss.

A tap contributes one component, a hold contributes two. Let `C` be the number
of components in the **entire chart**, `w[j]` the table weight, and `n[j]` the counts:

```
maximum_points = 320 * C
achieved_points = sum(n[j] * w[j])
score = floor(1_000_000 * achieved_points / maximum_points)
sum(n[j]) == C
```

Under the input bounds all arithmetic fits in u64. Missed notes cannot shrink the
denominator. Runtime is O(notes + events), memory is O(notes + events) including
the deserialized witness; hashing temporarily stores only a chunk's hash state.

## Canonical commitments

All integers in the following encodings are unsigned, fixed-width **big-endian**.
ASCII domains are raw bytes with **no length prefix or NUL**. Addresses are raw
20-byte values; hashes are raw 32-byte values. JSON, serde, and bincode are never
commitment encodings. Bincode is only SP1 witness transport.

```
rulesetId = SHA256(ASCII("OSUMANIA_ONCHAIN_RULESET_V1"))
inputPolicyHash = SHA256(ASCII("OSUMANIA_INPUT_POLICY_V1"))

chartHash = SHA256(
  ASCII("OSUMANIA_CHART_V1") || uint16(1) || uint8(4) || uint32(noteCount)
  || for each note: uint8(lane) || uint64(start_us) || uint64(end_us)
)

H0 = SHA256(ASCII("OSUMANIA_TRACE_V1") || sessionId)
Hi+1 = SHA256(Hi || uint32(chunkIndex) || uint16(chunkEventCount) || encodedEvents)
event = uint32(sequence) || uint64(timestamp_us) || uint8(lane) || uint8(action)
```

Chunks are exactly 32 events except the last, which has 1..32. No empty terminal
chunk. For an empty trace, `traceRoot = H0`. Indices start at zero. This fixes chunk
boundaries, length and order; each event is 14 bytes. See Python/Rust boundary vectors.

```
sessionDigest = SHA256(
  ASCII("OSUMANIA_HARDWARE_SESSION_V1") || uint16(1)
  || uint64(chainId) || address(verifier)
  || bytes32(matchId) || bytes32(sessionId) || bytes32(challenge)
  || address(player) || address(device)
  || bytes32(chartHash) || bytes32(rulesetId)
  || bytes32(bitstreamHash) || bytes32(inputPolicyHash)
  || uint32(eventCount) || uint64(duration_us) || bytes32(traceRoot)
)
```

The guest recomputes both commitments, checks them against the witness header/footer,
validates the full chart and trace, computes the score and publishes `sessionDigest`.
It does **not** authenticate the witness header or verify a device signature. That
is the proof consumer's mandatory job. Re-sealing a forged trace can yield a valid
computation proof but not an accepted result without a registered device signature.

## Public values ABI

Exactly 512 bytes: Solidity `abi.encode(PublicValues)` with no dynamic offsets.

```
bytes32 sessionId;
bytes32 chartHash;
bytes32 rulesetId;
bytes32 traceRoot;
bytes32 sessionDigest;
uint32 eventCount;
uint64 durationUs;
uint32 score;
uint64 achievedPoints;
uint64 maximumPoints;
uint32[6] judgements; // PERFECT, GREAT, GOOD, OK, MEH, MISS
```

Each scalar and array element occupies a 32-byte ABI word. Integer words are
left-zero-padded. Rust and Solidity share a checked golden vector.

## Proof acceptance and trust

`ManiaScoreVerifier` is an application adapter, not an implementation of SP1 cryptography.
Its immutable SP1 verifier must be a real compatible deployment and its immutable
programVKey must be generated from this exact guest ELF. The organizer registers
trusted device signer addresses/bitstream hashes and opens a chart-bound session
before play. The session ID is unique per contract/chain/nonce; the challenge is
fresh context, not an unpredictable randomness guarantee. No header overwrite API exists.

The adapter checks the stored player/device/chart/ruleset/context, deadline, current
device authorization, recomputed session digest, raw-digest secp256k1 signature,
and SP1 proof. It accepts a session once; a failed check never consumes it. Relayers
cannot change the recorded player. Registry changes and revocation can invalidate
pending sessions. The organizer is trusted to enroll devices and approve charts.

Signature wire format is 65 bytes `r || s || v`, with `v` 27 or 28 and low-s.
There is no Ethereum personal-message prefix. Hardware DER output must be converted,
with the recovery ID derived against the registered public key and adjusted if
normalizing s. Actual controller enrollment, secure boot, key generation, clock,
debouncing, ARM/START/STOP completeness and signature delivery are outside this code.

Input deletion after recording cannot preserve the signed root. Stopping the controller
early, resetting it, signing arbitrary digests, or suppressing edges inside compromised
hardware must be prevented by hardware policy; hashing alone cannot do that. The duration
check covers the full chart but does not itself prove a trustworthy physical recording.

No assertion is made that a human played, the host displayed authentic audio/video,
the device resisted physical automation, or witness privacy is provided. No escrow,
match winner calculation, payout, production attestation, client capture or USB driver
is implemented. Core proofs are not directly EVM-verifiable; the Groth16 command
produces the adapter's expected proof format using the configured SP1 backend.
