# OSUMANIA_GKR_V1 — sumcheck/GKR scoring proofs (normative)

This document specifies the active GKR proof system. The former SP1 implementation has been removed. The
**scoring semantics are unchanged**: the proven function is exactly
`OSUMANIA_ONCHAIN_RULESET_V1` (`../SCORING_SPEC.md`, `core::evaluate`). What
changes is how correctness is proven: a data-parallel constraint system checked
with a sumcheck, logUp-style multiset arguments reduced with GKR, and a
multilinear KZG opening (Zeromorph). No zkVM, no recursion, and no Groth16 wrapper.

The SP1 design spends minutes because it proves a RISC-V execution of the scorer
and then wraps the STARK in Groth16. Here the proof system is specialised to the
scorer. The prover performs O(N log N) field work plus a few multi-scalar
multiplications of size about 2^20 for a 3000-note chart.

Status labels used below: **MUST** = verifier-enforced and implemented;
**ASSUMPTION** = trust placed outside the proof.

---

## 1. Trust model and guarantees

Same trust roots as SP1 V1, plus a powers-of-tau SRS:

| Component | Role | Trusted for |
|---|---|---|
| Registered device (FPGA+SE050) | produces trace, signs `sessionDigest` | recording the physical input truthfully (ASSUMPTION, unchanged) |
| Organizer | registers devices, opens sessions, registers charts | enrollment (ASSUMPTION). Chart content is validated **on-chain** at registration (§8.1). |
| SRS (powers of tau, BN254) | KZG binding | at least one honest ceremony contributor (ASSUMPTION). The repo's dev SRS is **insecure** (known τ) and for testing only. |
| Prover / sidecar / relayer | computes proof, submits | nothing |
| Contract | verifies everything below | consensus |

If the contract accepts, it holds with overwhelming probability (Fiat–Shamir in the
ROM with Keccak256, KZG binding under q-SDH in the AGM) that:

1. the session was opened on this contract for this player, device and chart;
2. the registered device signed `sessionDigest` over the header and footer, and
   the footer binds the complete trace (mode A: SHA-256 hash chain recomputed
   on-chain from calldata; mode B: the device's KZG commitment to the trace);
3. the claimed judgement counts are exactly those `core::evaluate` produces for
   that chart and trace, and the trace satisfies every V1 validity rule;
4. the session is consumed once.

Not claimed (same as SP1): human play, authentic A/V on the host, physical-automation
resistance, privacy/zero-knowledge. Mode A publishes the trace in calldata.

## 2. Two trace-binding modes

| | Mode A `CALLDATA` | Mode B `DEVICE_KZG` |
|---|---|---|
| Hardware protocol | **unchanged** SP1 V1 (SHA-256 chain, `OSUMANIA_HARDWARE_SESSION_V1` digest) | device additionally computes a KZG commitment to the trace (§7.3) and signs digest V2 |
| On-chain trace data | 14 B/event calldata, hashed on-chain | none |
| Trace evaluation claim | verifier evaluates the trace MLE natively (O(n)) | opened with the batched Zeromorph proof (O(log n)) |
| inputPolicyHash | `SHA256("OSUMANIA_INPUT_POLICY_V1")` | `SHA256("OSUMANIA_INPUT_POLICY_V2_KZG")` |

The proof is identical in both modes except for the final opening. A session's
mode is fixed when the session is opened.

## 3. Field, encodings, and notation

- `F` = BN254 scalar field, `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
  Field elements on the wire are 32-byte big-endian and **MUST** be `< p`.
- G1 points are `(x, y)` 32-byte BE words; the identity is `(0, 0)`. Points are
  checked on-curve by the precompiles.
- MLE convention: a vector `v` of length `2^k` defines `ṽ(x_0..x_{k-1}) = Σ_i v_i·eq(bits(i), x)`,
  where `bits(i)` is **little-endian**. Variable `x_0` is the least-significant index bit.
  `eq(a, b) = Π_j (a_j b_j + (1-a_j)(1-b_j))`.
- A vector of length `2^a` zero-padded to `2^b` has MLE
  `ṽ(x_{<a}) · Π_{j≥a} (1 - x_j)`.
- Public MLEs evaluable in O(k): `id(x) = Σ_j 2^j x_j`; `isFirst = eq(x, 0)`;
  `isLast = eq(x, 1…1)`; `eqc(x; c) = eq(x, bits(c))`; step `[x < n]`, evaluated MSB-first by
  `Σ_{j: n_j = 1} (1 - x_j) Π_{i>j} eq(x_i, n_i)` (the MLE of the indicator, n < 2^k).

## 4. Statement

Public inputs of one proof:

- `mode ∈ {1 = A, 2 = B}`; `sessionDigest` (V1 for A, V2 for B);
- footer values `n` (event count ≤ 50,000) and `D` (duration µs ≤ 1,800,000,000);
- registered chart record `(C_N, m, R_N, C, maxEnd)` (§8.1);
- mode B only: device trace commitment `C_E` (inside the signed digest);
- claimed counts `J[0..5)` for PERFECT, GREAT, GOOD, OK, MEH;
- lane-table sizes `R_L[0..4) ≤ 17`, chosen by the prover.

The verifier computes natively:
`D ≥ maxEnd + 136500`, `D ≤ MAX_DURATION`, `ΣJ ≤ C`, `MISS = C - ΣJ`,
`achieved = 320J0 + 300J1 + 200J2 + 100J3 + 50J4`, `maximum = 320C`,
`score = floor(1e6 · achieved / maximum)`. Also `R_E = ceil(log2(n + 1))`, so
the trace table always has at least one row past the last event.

## 5. Witness tables

All tables are column-oriented, each with `2^{R_T}` rows. Rows past the real content are
zero. Constants: `W = 136500`, `S = 2^16`.

### 5.1 Trace table `E` (`R_E` rows bits)

| column | kind | meaning |
|---|---|---|
| `t, lane, act` | **source** (device/calldata) | event j fields; `seq = j` is implicit |
| `P` | advice | previous event time (`P_0 = 0`) |
| `d0..d3` | advice | byte limbs of the range-checked gap |
| `realE = [j < n]`, `isEnd = eq(j, n)`, `isFirst`, `idx = id` | public | |

### 5.2 Chart table `N` (`R_N` row bits, `m` real rows)

| column | kind | meaning |
|---|---|---|
| `lane, s, e, hold, kl` | **source** (registered commitment) | note fields, `hold = [e > s]`, `kl` = lane-local index in chart order |
| `hit, th, rel, u, hh` | advice | head hit, hit time, released, release time, `hit·hold` |
| `σ, h0..h4` | advice | head sign and one-hot class |
| `τ, g0..g5` | advice | tail sign and one-hot class (`g5` = MISS) |
| `ℓ0..ℓ13` | advice | byte limbs (head 3+3, tail 4+4) |
| `realN = [k < m]` | public | |

### 5.3 Lane timeline tables `T_L`, L = 0..3 (`R_L` row bits)

For lane L, the timeline contains one row per lane-L event, and two rows per lane-L note:
OPEN and CLOSE. Real rows appear in increasing sort key `K`; padding rows (all type bits 0)
may appear anywhere and are no-ops.

| column | kind | meaning |
|---|---|---|
| `isO, isC, isD, isU` | advice | row type bits (OPEN, CLOSE, DOWN, UP) |
| `v` | advice | `s` for OPEN/CLOSE, `t` for DOWN/UP |
| `q` | advice | event sequence number (0 for note rows) |
| `kl` | advice | lane-local note index (0 for event rows) |
| `O, F, H, A, Kx, lastK` | advice | state **before** the row: opened notes, front index, key held, tail active, tail note index, last real sort key |
| `inv` | advice | inverse witness for DOWN/CLOSE equality tests |
| `mD` | advice | DOWN row that consumed a head |
| `cC` | advice | CLOSE row that expired the front note |
| `ℓ0..ℓ6` | advice | byte limbs of `K - lastK` |
| `isFirst, isLast, id` | public | |

Virtual (defined, not committed):
`isReal = isO+isC+isD+isU`,
`K = S·(4v·isO + (4v+8W+2)·isC + (4v+4W+1)·(isD+isU)) + q·(isD+isU)`.

The state after the row is also virtual:
`O' = O+isO`, `F' = F+mD+cC`, `H' = H+isD−isU`, `A' = (1−isD−isU)A + mD`,
`Kx' = (1−isD−isU)Kx + mD·F`, and `lastK' = lastK + isReal(K − lastK)`.

**Why this is the V1 scorer.** Within one lane, `core::evaluate` is equivalent to a
queue of opened, unconsumed notes over the merged timeline. A note opens at
`s − W`, inclusive for DOWN events. An event at `t` sorts as `t`, and a note
closes (expires) just after `s + W`. The queue is always the contiguous
index range `[F, O)`, which gives these transitions:

- OPEN: `O += 1`;
- DOWN: `F += [F < O]`, and that DOWN is matched with note `F`;
- CLOSE(k): `F = max(F, k+1)`, which equals `F += [F == k]` because `F ≥ k` holds there;
- UP: the release time of the most recently matched note.

The sort key encodes the tie rules: OPEN before an event at the same instant,
and CLOSE after an event at `s+W`. The order of the tie ranks is
`(4s) < (4(t+W)+1) < (4(s+2W)+2)` on the `×4` time scale. Then `seq` orders
events with equal times. The equivalence is checked by differential fuzzing
against `core::evaluate` (§10).
The invariants `F ≤ O` and `F ≥ kl` at CLOSE follow inductively from the constraints below.
The same holds for the lane-local indices being consecutive in `s` order, which
C7 enforces. So each equality test reduces to a nonzero test with an inverse witness.

### 5.4 Byte table `B` (8 row bits)

`val = id` (public, 0..255); advice multiplicity `μ`.

## 6. Relation

### 6.1 Polynomial constraints (must vanish on every row)

Every constraint vanishes on an all-zero row, so zero-padding is sound.
Lane table `T_L`:

```
L1-L4  isX(isX-1)                       for X in O,C,D,U
L5     isReal(isReal-1)
L6     isReal(K - lastK - Σ_{i<7} 256^i ℓi)
L7     isO(kl - O)
L8     isD·H
L9     isU(1 - H)
L10    mD(mD-1)          L11 mD(1 - isD)
L12    isD(1 - mD)(O - F)
L13    mD((O - F)inv - 1)
L14    cC(cC-1)          L15 cC(1 - isC)
L16    cC(F - kl)
L17    (isC - cC)((F - kl)inv - 1)        (= isC(1-cC)(…) given L15; degree 3)
L18-23 isFirst·X                         for X in O,F,H,A,Kx,lastK
```

Chart table `N` (`LO = [0,19501,49501,82501,112501]`, `HI = [19500,49500,82500,112500,136500]`,
`LO' = LO ++ [136501]`, `HI' = HI ++ [2^32-1]`):

```
N1 hit(hit-1)   N2 rel(rel-1)   N3 rel(1-hit)   N4 hit(1-realN)
N5 hh - hit·hold
N6 σ(σ-1)       N7-N11 hc(hc-1)          N12 Σhc - hit
N13 (2σ-1)(th-s) - ΣhcLOc - (ℓ0+2^8ℓ1+2^16ℓ2)
N14 ΣhcHIc - (2σ-1)(th-s) - (ℓ3+2^8ℓ4+2^16ℓ5)
N15 τ(τ-1)      N16-N21 gc(gc-1)         N22 Σgc - hh
N23 hh(1-rel)(1-g5)
N24 hold(2τ-1)(u-e) - Σgc LO'c - (ℓ6+2^8ℓ7+2^16ℓ8+2^24ℓ9)
N25 Σgc HI'c - hold(2τ-1)(u-e) - (ℓ10+2^8ℓ11+2^16ℓ12+2^24ℓ13)
```

Trace table `E`:

```
E1 realE(t-P) + isEnd(D-P) - (d0+2^8d1+2^16d2+2^24d3)
E2 isFirst·P
E3 realE·act(act-1)
```

Maximum constraint degree 3. The limbs lie in [0,256), and every checked quantity is
genuinely below 2^49, so a range check of `x` rejects negative (wrapped) values.

### 6.2 Multiset relations (logUp)

Fingerprint `φ(tag; a1..a8) = tag + Σ_i α^i a_i`, leaf denominator `γ − φ`. The
relation holds iff `Σ_leaves p/(γ − φ) = 0`. Slots are listed as `(multiplicity p; tuple)`:

| table | slot | p | tuple |
|---|---|---|---|
| T_L | ROW | `isReal` | `(isO+2isC+3isD+4isU; L, v, q, kl)` |
| T_L | MATCH | `mD` | `(5; L, v, 0, F)` |
| T_L | RELEASE | `isU·A` | `(6; L, v, 0, Kx)` |
| T_L | STATE_IN | `-(1-isFirst)` | `(7; L, id, O, F, H, A, Kx, lastK)` |
| T_L | STATE_OUT | `1-isLast` | `(7; L, id+1, O', F', H', A', Kx', lastK')` |
| T_L | LIMB i<7 | `1` | `(9; ℓi)` |
| E | EVENT | `-realE` | `(3+act; lane, t, idx, 0)` |
| E | COPY_OUT | `realE` | `(8; idx+1, t)` |
| E | COPY_IN | `-(realE+isEnd)(1-isFirst)` | `(8; idx, P)` |
| E | LIMB i<4 | `1` | `(9; di)` |
| N | OPEN | `-realN` | `(1; lane, s, 0, kl)` |
| N | CLOSE | `-realN` | `(2; lane, s, 0, kl)` |
| N | MATCH | `-hit` | `(5; lane, th, 0, kl)` |
| N | RELEASE | `-hit·rel` | `(6; lane, u, 0, kl)` |
| N | LIMB i<14 | `1` | `(9; ℓi)` |
| B | TABLE | `-μ` | `(9; val)` |

What these slots achieve:

- The timeline is exactly the merged events and notes of each lane.
- Each state's successor equals the next row's input state.
- Consecutive trace events are chained.
- Chart hits and releases are exactly those emitted by the timeline.
- Every limb is a byte.

### 6.3 Output

`J_c = Σ_rows(N) (h_c + g_c)` for c < 5. The combination of 6.1–6.3 is equivalent to
`core::evaluate(chart, trace, D)` returning counts with non-MISS part `J` (V1 validity
errors ⇔ unsatisfiable).

## 7. Proof system

### 7.1 Transcript

Keccak256 over a 32-byte state `s`. `init(dom)`: `s = keccak(dom)`.
`absorb(w_1..w_k)`: `s = keccak(s ‖ w_1 ‖ … ‖ w_k)` (k ≥ 1, each a 32-byte word).
`squeeze()`: `s = keccak(s)`, and the challenge is `uint256(s) mod p`. Domain:
`"OSUMANIA_GKR_V1"`. Absorbed first, in order:

```
[1, mode, sessionDigest, n, D, m, R_N, C, R_L0..3, J0..4,
 srsId, C_N.x, C_N.y, (mode B: C_E.x, C_E.y), C_A.x, C_A.y]
```

`srsId = keccak256(τG2 ‖ τ^{Dmax+1-2^k}G2 for k = 1..Smax)`, where each G2
point is 4 words (x.c1, x.c0, y.c1, y.c0), as the EVM expects. Every prover
message is absorbed immediately after it is sent. Challenges are squeezed in the
order they are listed below.

### 7.2 Protocol

1. **Commit.** Prover commits `ADV` (§7.4) → `C_A`; absorb statement (above).
2. Squeeze `α, γ`. Build all leaves (§6.2) in the leaf layout (§7.5), `2^G` leaves.
3. **Fractional-sum GKR.** Layer `k` has `2^k` nodes; node `x` of layer `k` combines children
   `2x, 2x+1` of layer `k+1`: `p = p_{2x}q_{2x+1} + p_{2x+1}q_{2x}`, `q = q_{2x}q_{2x+1}`.
   - Send layer 1 `(p0, p1, q0, q1)`, absorb. Verifier: `p0q1 + p1q0 = 0`, `q0q1 ≠ 0`.
     Squeeze `τ`; claim point `(τ)`, `P = p0 + τ(p1−p0)`, `Q = q0 + τ(q1−q0)`.
   - For `k = 1..G−1`: squeeze `λ_k`; run sumcheck (degree 3, `k` rounds) of
     `Σ_x eq(z, x)[P(0,x)Q(1,x) + P(1,x)Q(0,x) + λ_k Q(0,x)Q(1,x)] = P + λ_k Q`
     where `P(b,x)` is layer `k+1` at index `b + 2x`. Rounds send `g(0), g(2), g(3)`
     (`g(1) = claim − g(0)`), absorb, squeeze `ρ_j`. Then send `a0,a1,b0,b1` (children at
     `(0,ρ)`,`(1,ρ)`), check the final round value `eq(z,ρ)(a0b1 + a1b0 + λ_k b0b1)`,
     absorb, squeeze `τ`; new point `(τ, ρ)`, `P = a0+τ(a1−a0)`, `Q = b0+τ(b1−b0)`.
   - Output: leaf claims `P̄, Q̄` at `z ∈ F^G`.
4. **Row sumcheck.** Squeeze `λ, β, ζ, κ`, then `r ∈ F^{R_max}` (`R_max = max R_T`).
   Prove `Σ_{x∈{0,1}^{R_max}} F(x) = P̄ + λ(Q̄ − (1 − Σ_s χ_s(z))) + κ Σ_c ζ^c J_c` with
   `F(x) = Σ_T eq(r,x)·Σ_i β^{i} C_{T,i}(x) + Σ_T eq(z_T,x)·Σ_{s∈T} χ_s(z)(p_s(x) + λ q_s(x)) + κ Σ_c ζ^c (h_c+g_c)(x)`.
   `i` is a single global constraint counter in the order T_0..T_3, N, E (L1..L23, N1..N25, E1..E3).
   `z_T = (z_{<R_T}, 0…0)`; every table's columns are zero-padded to `R_max`.
   Rounds are degree 4 and send `g(0), g(2), g(3), g(4)`.
   At `r'`, the prover sends each table's column values at `r'_{<R_T}` in canonical column order. Order: T_0..T_3, N, E, B; advice columns, then source columns.
   The verifier recomputes `F(r')` using the padding factors `Π_{j≥R_T}(1−r'_j)`.
5. **Opening reduction.** Squeeze `μ`, weight the column claims in order by `μ^i`, and
   run sumcheck (degree 2, `A` rounds, send `g(0), g(2)`) of
   `Σ_x ADV(x)W_A(x) + TRACE(x)W_E(x) + CHART(x)W_N(x)`. At `z*`, the prover sends
   `ADV(z*)`, `CHART(z*)`, and (mode B) `TRACE(z*)`. The verifier computes `W_*(z*)`.
   In mode A, the verifier computes `TRACE(z*)` itself from calldata.
6. **Zeromorph opening** (§7.6) of `ADV + ν·CHART (+ ν²·TRACE)` at `z*`, with `ν` squeezed after step 5.

Interactive soundness error (union bound, `p ≈ 2^254`, at most `2^23` leaves/items):

- the sumcheck/GKR rounds contribute `≈ 4·(G²/2 + R_max + A)/p ≈ 2^{-244}`;
- the logUp identity at a random `γ` contributes `#leaves/p ≈ 2^{-231}`;
- fingerprint injectivity over α for committed tuples contributes `8·#items²/p ≈ 2^{-205}`;
- Zeromorph (Schwartz–Zippel at `x`, KZG binding) contributes `2^N/p` plus q-SDH/AGM.

The total is about `2^{-205}`.

Under Fiat–Shamir, a prover making `Q` hash queries gains at most a factor `Q`
(so `≈ 2^{-125}` for `Q = 2^80`). The `mod p` challenge bias adds a factor of at most 1.25.

### 7.3 Committed polynomial layouts

Let `U(v)(X) = Σ_i v_i X^i` (Zeromorph's monomial-basis identification) and
`[v] = Σ_i v_i·[τ^i]_1`.

- `TRACE` (mode B, **device-computed**): row-major, 4 slots: index `4j + c`, `c = 0:t, 1:lane, 2:act, 3:0`.
  The device streams `C_E += t_j[τ^{4j}] + lane_j[τ^{4j+1}] + act_j[τ^{4j+2}]`.
  This needs only the first `4·2^16` G1 powers. Padding with zeros does not
  change the commitment, so the prover's `R_E` does not affect it.
- `CHART` (organizer): row-major, 8 slots: `8k + c`, `c = 0:lane,1:s,2:e,3:hold,4:kl`.
- `ADV` (prover): one block per table and **column-major** inside a block
  (`row + 2^{R_T}·col`). Column slots are 32 per lane, 32 for the chart, 8 for the trace,
  and 1 for the byte table. Blocks are sorted by size (descending, ties in order
  T_0..T_3, N, E, B), then concatenated. Each block is therefore aligned to its size.
  `A = max(log2 |ADV|, 2+R_E, 3+R_N)`.

### 7.4 Advice column order (canonical)

- Lane: `isO,isC,isD,isU,v,q,kl,O,F,H,A,Kx,lastK,inv,mD,cC,ℓ0..ℓ6` (23).
- Chart: `hit,th,rel,u,hh,σ,h0..h4,τ,g0..g5,ℓ0..ℓ13` (32).
- Trace: `P,d0..d3` (5).
- Byte: `μ` (1).

Source columns are listed after the advice columns in step 4 claims: trace `t,lane,act`; chart `lane,s,e,hold,kl`.

### 7.5 Leaf layout

Each table contributes its slots in the order of §6.2, and each slot has size `2^{R_T}`. All slots
are sorted by size (descending; ties by table order T_0..T_3, N, E, B, then slot order).
They are placed contiguously from offset 0, so every slot is aligned. `G = ceil(log2(total))`.
Unused leaves have `p = 0, q = 1`. The selector is
`χ_s(z) = eq(offset_s / 2^{R_T}, z_{R_T..G-1})`.

### 7.6 Zeromorph with an explicit degree check

For `f` with `n` variables and `N = 2^n`, the evaluation point is `u` and the value is `v`:

- Quotients are computed from the top variable down, with `q_k ∈ F^{2^k}`:
  `q_k[i] = f^{(k+1)}[i+2^k] − f^{(k+1)}[i]` and `f^{(k)} = f^{(k+1)}_{low} + u_k q_k`.
  Commit `[q_k]`, absorb, squeeze `y`.
- `q̂ = Σ_k y^k X^{N−2^k} U(q_k)`: commit `[q̂]` and `[q̂'] = [X^{Dmax+1−N} q̂]`, absorb, squeeze `x, z`.
- `ζ = q̂ − Σ y^k x^{N−2^k} U(q_k)`,
  `Z = U(f) − vΦ_n(x) − Σ_k (x^{2^k}Φ_{n−k−1}(x^{2^{k+1}}) − u_kΦ_{n−k}(x^{2^k}))U(q_k)`,
  where `Φ_j(X) = (X^{2^j} − 1)/(X − 1)`.
- Send `π = [(ζ + zZ)/(X − x)]`, absorb, squeeze `ρ`.
- Verify
  `e(C + xπ + ρq̂', [1]_2) · e(−π, [τ]_2) · e(−ρq̂, [τ^{Dmax+1−N}]_2) = 1`,
  where `C = [ζ + zZ]` is formed from `[q̂], [q_k], [f], [1]_1`.

The second pairing factor proves `deg q̂ < N`, and hence `deg U(q_k) < 2^k`, which the
identity needs for soundness. All prover MSMs have size ≤ N.

## 8. Contracts

### 8.1 Chart registration (`registerChart`, organizer, once per chart)

Input: the SP1-canonical chart bytes (`OSUMANIA_CHART_V1`…), `C_N`, and a Zeromorph proof.

The contract:
- validates every V1 chart rule (4 keys, 1..10,000 notes, strict `(s, lane)` order,
  same-lane `start > previous end`, `e ≤ MAX − W`);
- computes `chartHash = SHA256(bytes)`, which equals SP1's `chartHash`;
- derives `hold`, `kl`, `C = Σ(1 + hold)`, `maxEnd`, and `R_N = ceil(log2 m)`.

It then checks that the chart bytes and `C_N` agree. Transcript: `init("OSUMANIA_GKR_CHART_V1")`,
absorb `[chartHash, C_N.x, C_N.y]`, squeeze `u ∈ F^{3+R_N}`. The contract evaluates
`v = CHART(u)` natively from the bytes, absorbs `[v]`, and verifies the Zeromorph opening
of `C_N` at `u` to `v` on the same transcript (§7.6). By Schwartz–Zippel, `C_N` commits
exactly this chart, so the organizer is trusted for approval only, not for computing
the commitment. Registration is one-time per chart (gas in the README).

### 8.2 Sessions and submission

Devices and sessions match SP1 V1. One exception: `openSession` takes `mode` and
requires a registered chart. The header's `inputPolicyHash` is chosen by mode.

`Submission = (u64 duration D, u8[4] R_L, u32[5] J)`. Both functions take the session id.

- `submitCalldata(id, events, Submission, proof, sig)` (mode A):
  - `events` is `n × 14` bytes (`u32 seq ‖ u64 t ‖ u8 lane ‖ u8 act`), and `seq == j` is enforced;
  - the `traceRoot` SHA-256 chain is computed as in SP1 V1;
  - `sessionDigest V1` is computed and checked with `ecrecover` (low-s, v ∈ {27, 28});
  - the proof is verified with `TRACE(z*)` evaluated from `events`.
- `submitCommitted(id, n, traceRoot, C_E, Submission, proof, sig)` (mode B):
  - `sessionDigest V2 = SHA256("OSUMANIA_HARDWARE_SESSION_V2" ‖ u16(2) ‖ <V1 fields> ‖ u32 n ‖ u64 D ‖ traceRoot ‖ C_E.x ‖ C_E.y)`
    is checked;
  - `C_E` enters the batched opening.

In both modes the contract:
- recomputes the score (§4) and records it once per session;
- lets anyone relay the submission, while the recorded player always comes from the session;
- does not consume the session on a failed check.

## 9. Parameters and bounds

`n ≤ 50,000`, `m ≤ 10,000`, `D ≤ 1.8·10^9`, `R_L ≤ 17`, `R_E ≤ 16`, `R_N ≤ 14`,
`G ≤ 23`, `A ≤ 24`, and `A ≤ Smax`, the SRS size exponent in the contract.
The dev SRS has `Smax = 22`, which covers charts up to roughly 6,000 notes with
typical density. Larger instances need a larger ceremony SRS.

## 10. Test obligations (implemented)

Rust (`cargo test --release`):
- unit tests: transcript/keccak vector, MLE identities, interpolation, fractional-sum GKR
  (honest + tampered), Zeromorph (open/verify, wrong value, tampered π, tampered q̂',
  zero-padding invariance), and SRS save/load;
- `table_polynomials_have_degree_at_most_four`: every table polynomial has degree ≤ 4
  along random lines, the sumcheck degree bound;
- differential tests:
  - `honest_witnesses_satisfy_relation`: 3000 random charts/traces; every constraint vanishes on
    every row and the logUp sum balances;
  - `differential_random_corpus`: 3000 random inputs, including invalid ones. The timeline
    counts equal `core::evaluate` (validity agrees), and a subset is fully proven and verified
    in both modes;
  - both SP1 fixtures in both modes, plus benchmark shapes;
- tampering:
  - proof sections: counts, claims, rounds, openings, GKR, lane sizes;
  - statement values: digest, duration, chart record;
  - a different calldata trace, and a different device commitment;
- malicious witnesses: forged judgement class, dropped hit, suppressed match, reordered
  timeline rows, out-of-range limb. All are rejected;
- encoding round-trip and non-canonical word rejection.

Foundry (`forge test`, FFI to the Rust prover):
- every exported case (fixtures, random, 500/3000 notes, both modes) verifies on-chain with
  judgements/score equal to `core::evaluate`;
- tampering:
  - every proof section rejects ±1, as do truncated/extended proofs and non-canonical words;
  - statement mutations are rejected;
  - a modified calldata trace, a foreign trace commitment, and mode confusion are rejected;
- chart registration: `chartHash` equals SP1's; foreign commitment, content change after
  commitment, unsorted chart, non-organizer, and duplicate registration are rejected;
- end-to-end sessions in both modes: the contract issues the header, Rust proves against it,
  and the Rust digests equal the Solidity digests.
  - Also tested: wrong device key, relayer ownership, replay, revocation, expiry, and mode mismatch.
