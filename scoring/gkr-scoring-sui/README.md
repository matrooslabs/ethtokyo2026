# GKR/sumcheck osu!mania scoring proofs on Sui

[`../gkr-scoring`](../gkr-scoring)의 채점 증명(`OSUMANIA_GKR_V1`)을 **Sui에서 온체인 검증**하는 포트입니다.
채점 함수(`core::evaluate`), 관계식, 프로토콜 구조는 그대로입니다. Move 검증기가 증명 전체를 한 트랜잭션에서 검증합니다.

- 규범 명세(EVM 대비 변경분): [SPEC-SUI.md](SPEC-SUI.md)
- 원본 명세: [../gkr-scoring/SPEC.md](../gkr-scoring/SPEC.md)

## 무엇이 바뀌었나

| | EVM 버전 (`gkr-scoring`) | Sui 버전 (이 디렉터리) |
|---|---|---|
| 커브 / field | BN254 | **BLS12-381**. Sui는 BN254 pairing·ecMul을 제공하지 않고, 범용 group 연산은 `sui::bls12381`만 있습니다. |
| 검증기 | Solidity + Yul | Move (`move/sources/*.move`, bytecode 37 KB) |
| Transcript | keccak(s ‖ words) | keccak(**BCS**(s, items)), squeeze는 상위 2비트 마스킹 (§3) |
| proof 전달 | `uint256[]` calldata | 32/48-byte item 리스트, 16 KiB씩 PTB 인자로 나눔 |
| 채보 등록 | 한 트랜잭션 | 업로드 → 검증(재개 가능) → 등록. 여러 트랜잭션에 나눌 수 있습니다. |
| 모드 A trace | calldata | `TraceUpload` 객체에 올리고, 온체인에서 SHA-256 chain을 재계산합니다. |
| 장치 프로토콜 | V1 digest + secp256k1 | **모드 A는 동일합니다** (같은 digest, 같은 65B 서명). 모드 B는 BLS12-381 commitment가 필요합니다. |

## 실행

```sh
cd gkr-scoring-sui
cargo build --release && cargo test --release                 # Rust: 단위 18 + 통합 9
./target/release/mania-gkr-sui srs --smax 24 --out artifacts/dev-srs-24.bin   # INSECURE 개발용, 약 25초, 1 GB
./target/release/mania-gkr-sui export-move --srs artifacts/dev-srs-24.bin --out move   # [--heavy]
(cd move && sui move test --statistics)                         # Move: 84개 (--heavy면 +2)

# 로컬넷 end-to-end
sui start --with-faucet --force-regenesis &                     # 별도 터미널
(cd scripts && npm install && node sui_e2e.mjs --srs ../artifacts/dev-srs-24.bin --case bench3000)
node scripts/sui_e2e.mjs --srs artifacts/dev-srs-24.bin --case spam10k --modes b   # 최악 케이스
# 테스트넷: 활성 `sui client` 키로 서명 (gRPC; 공개 fullnode의 JSON-RPC는 폐기됨)
node scripts/sui_e2e.mjs --network testnet --srs artifacts/dev-srs-24.bin --case bench4 --modes b
```

- `move/tests/fixtures.move`는 `export-move`가 생성합니다(약 2 MB). 픽스처가 SRS에 묶여 있으므로, SRS를 바꾸면 다시 생성해야 합니다.
- CLI 명령:
  - `prepare-chart`: 채보 commitment, 등록 proof, VK
  - `prove-session`: 온체인 세션 header를 받아 증명하고 서명
  - `play`: 합성 플레이 생성

## 결과

### 로컬넷 end-to-end (실제 트랜잭션, Sui 1.80.1)

`scripts/sui_e2e.mjs`가 배포 → registry·장치 → 채보 등록 → 세션 → 증명 → 제출을 실제로 수행했습니다. 점수가 `core::evaluate`와 일치했습니다.
동시에 판정을 한 칸 옮긴 위조 카운트(합은 같음)가 GKR 검사에서 거부되는 것도 확인했습니다.
원본은 [docs/benchmarks/localnet-e2e-20260926](docs/benchmarks/localnet-e2e-20260926)에 있습니다.

| 트랜잭션 | 3,000노트 / 6,000 이벤트 | 최악: 10,000노트 / 50,000 이벤트 연타 |
|---|---:|---:|
| 채보 업로드 | 0.48M unit (51.6 KB tx) | 1.11M + 0.66M (2 tx) |
| 채보 검증 (`process_chart`) | 1.56M | 1.59M + 1.58M + 1.58M + 0.49M (4 tx) |
| 채보 등록 (Zeromorph opening) | 1,890 | 4,050 |
| **모드 B 제출** (서명 + 전체 증명 검증) | **0.36M** (29 KB tx) | **0.47M** (36 KB tx) |
| 모드 A trace 업로드 | 1.80M (85 KB tx) | — (모드 A 한도 초과) |
| 모드 A 제출 | 0.93M (29 KB tx) | — |

- 단위는 computation unit입니다. 트랜잭션당 상한은 5,000,000입니다.
- 비용은 unit × reference gas price입니다. 로컬넷과 테스트넷 모두 1,000 MIST라서 모드 B 3,000노트 제출이 약 0.36 SUI입니다. 네트워크 가격에 비례합니다.

### 테스트넷 배포 (2026-09-26)

| 항목 | ID |
|---|---|
| 패키지 | [`0x031595e9…1f22`](https://suiscan.xyz/testnet/object/0x031595e9aec31931c3a4d5def7c4f0f3212336b96b18650ab8c8086e87261f22) |
| Registry (shared) | `0x7fc5de16273b346cdeee9e627ed3750cf07910bee1239c7599f2975a83df7f62` |
| OrganizerCap | `0xff89bc1306f593aec910f13305d35ed21a3b3641a980a5294830baf293e620d5` (소유자 `0xfac7…d246`) |
| 모드 B 제출 | [`4apKVLbd…LN8X7`](https://suiscan.xyz/testnet/tx/4apKVLbdsm7V5ca1mLsQ3MWgUttiV39ZuX4ma5NLN8X7), 148,300 unit, 점수 1,000,000 |

- 4노트 채보로 배포 → registry·장치 → 채보 등록 → 세션 → 모드 B 제출까지 실제 테스트넷 트랜잭션으로 수행했습니다. 판정을 옮긴 위조 카운트는 거부됐습니다.
- 예산(약 1 SUI) 때문에 작은 채보로 모드 B만 돌렸습니다. 모드 A와 3,000노트 경로는 로컬넷에서 검증했습니다.
- registry의 VK는 **개발용 SRS**(τ 공개)라서 누구나 점수를 위조할 수 있습니다. 데모 전용입니다.
- 모든 digest는 [docs/benchmarks/testnet-20260926](docs/benchmarks/testnet-20260926)에 있습니다.
- 먼저 올린 패키지 `0x29a53453…b4fc`는 쓰지 마세요. testnet에서 꺼져 있는 MSM native를 호출해서 채보 등록이 실패합니다.

### 증명 시간 (M3 Max 16코어, 5회 중앙값, witness 포함)

| 노트 / 이벤트 | prove A / B | Zeromorph opening | proof |
|---:|---:|---:|---:|
| 500 / 1,000 | 0.50 / 0.49 s | 0.27–0.30 s | 21.4 KB |
| 1,500 / 3,000 | 1.39 / 1.35 s | 0.96–0.98 s | 25.3 KB |
| 3,000 / 6,000 | 2.42 / 2.33 s | 1.78–1.90 s | 27.4 KB |
| 10,000 / 20,000 | 7.13 / 7.01 s | 5.7 s | 31.9 KB |
| 10,000 / 50,000 연타 (모드 B) | 13.3 s | — | 34.4 KB |

- BN254 버전(3,000노트 1.6 s)보다 약 1.5배 느립니다. prover 쪽 BLS12-381 MSM이 더 무겁기 때문입니다.
- 원본: `docs/benchmarks/localnet-e2e-20260926/bench-sui.json`.

### 테스트

- **Move (`sui move test`, 84개)**
  - 10개 케이스에서 온체인 verifier 결과가 `core::evaluate`와 같습니다: SP1 fixture 2개 × 2모드, 무작위 2개, 500/3,000노트 × 2모드.
  - 등록·업로드·제출 경로를 테스트했습니다.
  - 변조 proof 35종이 모두 거부됐습니다: 각 구간 ±1, 다른 점, 잘림, 덧붙임, non-canonical scalar.
  - 레지스트리 테스트 14개: 리플레이, 서명 위조, trace·duration 변조, 카운트 부풀리기, 만료, 모드 혼동, 장치 폐기, 채보 중복·위조 commitment, 다른 registry의 cap, 채보 검증 재개, trace seq 위반, 실제 `open_session` header.
  - `--heavy`는 최악 케이스(10,000노트, 50,000 이벤트)를 포함하며, 제출 0.50M unit으로 통과했습니다.
- **Rust (`cargo test --release`)**
  - 원본 테스트 전체를 BLS12-381로 통과했습니다: 차등 3,000개, 악성 witness, 변조, 인코딩.
  - G1·G2 인코딩이 Sui 상수와 zkcrypto `bls12_381` 레퍼런스와 일치합니다(y 부호 두 경우 모두).

## 설계 메모: Sui gas 모델

측정해 보니 Sui는 **트랜잭션 안에서 실행한 명령어 수**에 따라 명령어 단가가 누진됩니다(`instruction_tiers`: 2만/5만/10만/20만).

- field·커브 연산은 native라 쌉니다. 새 트랜잭션에서 BLS12-381 곱셈은 0.29 unit입니다.
- 반대로 Move로 바이트를 하나씩 도는 루프는 비쌉니다. 처음 구현에서는 3,000노트 검증이 5M unit을 넘었습니다.
- `g1_multi_scalar_multiplication`(MSM) native는 **devnet/localnet에서만 켜져 있고** testnet·mainnet에서는 꺼져 있습니다(`enable_group_ops_native_function_msm`). 그래서 개별 `g1_mul`과 `g1_add`로 바꿨는데, 오히려 gas도 절반 이하로 줄었습니다.

그래서 다음처럼 바꿨고, 이것이 SPEC-SUI.md의 설계 이유입니다.

- scalar·point는 native로 디코딩합니다(정규성 검사 포함).
- transcript는 `bcs::to_bytes`로 프레이밍합니다.
- challenge는 `mod r` 대신 마스킹합니다.
- 상수는 미리 계산합니다.
- eq 테이블은 하위 10비트 테이블과 상위 비트 계수로 분할합니다.
- 채보 검증과 trace 업로드는 별도 트랜잭션으로 뺐습니다. 누진 단계는 트랜잭션마다 초기화됩니다.

## 한계와 남은 일

- **SRS:** 개발용 SRS는 τ가 알려져 있어 위조할 수 있습니다.
  - 운영에는 공개 BLS12-381 powers-of-tau(예: Filecoin phase-1, 2^27)로 만든 SRS가 필요합니다. `[τ]_2`와 shift 점 `[τ^{2^smax−2^n}]_2`도 필요합니다.
  - `.ptau` 로더는 BN254 전용이라 옮기지 않았습니다.
  - 최대 인스턴스에는 `smax ≥ 23`이 필요합니다.
- **모드 A 크기:** `TraceUpload` 객체 한도(250 KB) 때문에 모드 A는 약 7,000 이벤트까지입니다.
  - 이보다 큰 trace(연타 포함)는 업로드 트랜잭션이 실패하고, 해당 세션만 제출하지 못합니다.
  - 큰 trace는 모드 B로 처리해야 합니다.
- **모드 B 하드웨어:** 장치가 BLS12-381 G1 commitment를 계산해야 합니다. 기존 FPGA handoff 자료는 BN254 기준입니다.
- **비용:** 모드 B 제출은 약 0.36–0.47M unit입니다. 더 줄이려면 GKR 초반 층 묶기나 Groth16(BN254, `sui::groth16`) 래핑 같은 방법이 있습니다.
- **감사:** 받지 않았습니다. 해커톤 프로토타입입니다.
