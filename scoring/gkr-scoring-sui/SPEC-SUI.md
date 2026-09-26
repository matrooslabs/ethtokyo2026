# OSUMANIA_GKR_SUI_V1 — Sui port of OSUMANIA_GKR_V1 (normative delta)

This document specifies how `../gkr-scoring/SPEC.md` (OSUMANIA_GKR_V1) is verified on Sui.
Everything not listed here is unchanged: the scored function (`core::evaluate`), the witness
tables, the relation (§5–6), the protocol steps and their order (§7.2), the layouts (§7.3–7.5),
and the Zeromorph identity (§7.6).

## 1. Why the curve changes

Sui exposes pairing-friendly group operations only for BLS12-381 (`sui::bls12381`: scalar
arithmetic, G1/G2 add/mul, pairing; the G1 MSM native is enabled only on devnet/localnet, so the
verifier does not use it). BN254 is available only as a fixed
Groth16 verifier and Poseidon. The KZG/Zeromorph opening therefore moves to BLS12-381, and the
proof field becomes the BLS12-381 scalar field:

`r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001`.

Every relation quantity is checked below 2^49 (SPEC §6.1), far below r, so the relation is
unchanged.

## 2. Encodings

| object | encoding |
|---|---|
| scalar | 32-byte big-endian, canonical (< r). The native decoder rejects non-canonical values. |
| G1 | 48-byte ZCash-compressed (the `sui::bls12381::g1_from_bytes` format); subgroup-checked on decode |
| G2 | 96-byte ZCash-compressed |
| proof | the SPEC §7 message sequence as a list of **items** (one scalar or point each), passed as `vector<vector<vector<u8>>>` groups because a PTB pure argument is capped at 16 KiB |

The item order equals the EVM word order: `C_A`, GKR (layer 1, then per layer rounds×3 and
children×4), row rounds×4, claims, reduction rounds×2, `adv_eval, chart_eval[, trace_eval]`,
`q_0..q_{A-1}, q̂, q̂', π`.

## 3. Transcript

The transcript is designed so that Move computes it with natives only
(`bcs::to_bytes`, `keccak256`), since byte-level loops are the dominant cost on Sui (§7).

- `init(dom)`: `s = keccak256(dom)`; domains `"OSUMANIA_GKR_SUI_V1"` and
  `"OSUMANIA_GKR_SUI_CHART_V1"`.
- `absorb(items)`: `s = keccak256(BCS(s, items)) = keccak256(uleb(32) ‖ s ‖ uleb(k) ‖ Σ uleb(|w_i|) ‖ w_i)`,
  where `k ≥ 1`. The framing is injective.
- `squeeze()`: `s = keccak256(s)`. The challenge is `s` with its two most significant bits
  cleared, read big-endian. It is uniform on `[0, 2^254)` and always below r.

The statement absorbs the SPEC §7.1 values as items: eight 32-byte words
(`1, mode, sessionDigest, n, D, m, R_N, C`), the four `R_L` words, the five `J` words, `srsId`,
then the 48-byte points `C_N`, (mode B) `C_E`, and `C_A`. Each prover message is one absorb
of its items.

`srsId = keccak256(τG2 ‖ shift[1] ‖ … ‖ shift[smax])` over 96-byte compressed G2 points.

**Soundness.** Challenges range over 2^254 values instead of r ≈ 2^254.86. Each
Schwartz–Zippel term of SPEC §7.2 grows by a factor of at most 1.82, so the total stays
about 2^-204.

## 4. Session digests and device signatures

Mode A is the **unchanged hardware protocol**. It uses the V1 digest, SHA-256 trace chain, and
secp256k1 signature. The Header keeps its 20-byte fields, filled on Sui as follows:

| field | Sui value |
|---|---|
| `chainId` | a u64 fixed when the registry is created (Sui has no numeric chain id) |
| `verifier` | `keccak256(registry object id)[12..]` |
| `sessionId` | the Session object id |
| `challenge` | `keccak256(sessionId ‖ tx digest ‖ bcs(clock ms))` |
| `player` | `keccak256(bcs(player address))[12..]`. The full address is stored in the Session and receives the score. |
| `device` | EVM address of the registered compressed secp256k1 key, `keccak256(X‖Y)[12..]` |

The device signs `sessionDigest` exactly as for the EVM: 65 bytes `r ‖ s ‖ v`, with
`v ∈ {27, 28}` and low s. Sui checks it with
`ecdsa_k1::secp256k1_verify(r‖s, pubkey, preimage, SHA256)`. The native hashes the preimage
with SHA-256, which yields `sessionDigest`.

Mode B uses the V2 digest domain `"OSUMANIA_HARDWARE_SESSION_V2_BLS12381"` and the input policy
`SHA256("OSUMANIA_INPUT_POLICY_V2_KZG_BLS12381")`. The trace commitment `C_E` is a 48-byte
BLS12-381 point computed as in SPEC §7.3. A mode-B device therefore needs BLS12-381 hardware,
not BN254.

## 5. Chart registration (multi-transaction)

`ChartUpload` is an owned object. The steps are:

1. `append_chart` (bytes, ≤ 16 KiB per argument, any number of transactions);
2. `begin_chart(commitment)`: checks the header, sets `chartHash = SHA256(bytes)` (equal to the
   SP1 and EVM value), and derives the opening point;
3. `process_chart(max_notes)`: validates the V1 note rules and accumulates `CHART(u)`. It can be
   resumed across transactions;
4. `register_chart(proof)` (organizer capability): runs the Zeromorph opening and records the chart.

## 6. Mode A trace staging

`TraceUpload` is bound to one Session. `append_trace(chunks)` takes the device's chunks of
≤ 32 events (14 bytes each: `u32 seq ‖ u64 t ‖ u8 lane ‖ u8 act`). For each chunk it:

- recomputes `root = SHA256(root ‖ u32 index ‖ u16 count ‖ events)`;
- enforces `seq == index`, `lane < 4`, `act ≤ 1`, and that every chunk but the last is full;
- stores each timestamp as a scalar and the byte `lane | act << 2`.

`submit_calldata` consumes the upload. The verifier evaluates `TRACE(z*)` from the staged data
over 1024-row blocks. The object size limit (250 KB) caps mode A at about 7,000 events. Mode B
has no trace on-chain, so the SPEC limit of 50,000 events applies.

## 7. Cost model and limits

A transaction may spend at most 5,000,000 computation units. Sui prices bytecode instructions
in tiers by the number already executed in the transaction. Past about 200k instructions each
instruction costs roughly 100× the first tier, so byte loops dominate, not field or curve
operations. For example, a BLS12-381 scalar multiplication costs 0.29 units in a fresh
transaction.

The design therefore:

- decodes items with natives;
- avoids the MSM native (disabled on testnet/mainnet) in favour of single `g1_mul`/`g1_add`;
- frames the transcript with BCS;
- masks challenges instead of reducing them;
- precomputes constants;
- splits registration and uploads into separate transactions, since the tiers reset per
  transaction.

Parameters: `smax ≥ 23` is required by the largest instance (§9 of SPEC, `A ≤ 23` at the event
and note caps). The test SRS uses `smax = 24`.
