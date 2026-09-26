# GKR/sumcheck osu!mania scoring proofs

Rust crates are members of the shared [scoring workspace](../README.md). Run the commands below from `scoring/gkr-scoring/`; Cargo discovers `scoring/Cargo.toml`, and binaries are written to `scoring/target/`.

FPGA 입력 장치·모드 B commitment 구현은 [FPGA handoff 자료](docs/fpga/README.md)를 참고하세요. 바이트 규격, SRS ROM, 장치/sidecar 경계, 검증 벡터와 인수 기준을 포함합니다.

`../crates/scoring-core`의 **공통 채점 함수**(`OSUMANIA_ONCHAIN_RULESET_V1` = `core::evaluate`)를
SP1 zkVM 대신 **채점 전용 sumcheck/GKR 증명 시스템**으로 증명하고, Solidity에서 직접 검증하는
프로토타입입니다. SP1의 느린 proof 생성을 줄이는 것이 목표였습니다.

The SP1 implementation has been removed. SP1 timing/size comparisons below are historical measurements, not an active build or runtime dependency. Shared semantics and fixtures now live in `../crates/scoring-core` and `../fixtures`.

| 노트 / 이벤트 | **GKR prove (EVM 제출 가능)** | SP1 core prove (EVM 불가) | SP1 Groth16 (EVM 제출 가능) |
|---|---:|---:|---:|
| 500 / 1,000 | **0.38 s** | 22.7 s | (4노트 기존 실측 234 s) |
| 1,500 / 3,000 | **0.91 s** | 43.8 s | — |
| 3,000 / 6,000 | **1.55–1.64 s** | 64.0 s | **287.8 s** (wall 297 s, 최대 메모리 27 GB) |
| 3,000 전부 LN / 6,000 | **1.61 s** | 63.7 s | — |
| 10,000 / 20,000 | **4.4–4.8 s** | 측정 안 함 | — |

- 모든 수치는 같은 머신(Apple M3 Max 16코어)에서 측정했고, 입력은 SP1 `scripts/benchmark.py`와 같은 합성 채보·플레이입니다.
- **EVM에 제출 가능한 proof 기준으로 3,000노트는 287.8 s → 1.6 s, 약 180배 빠릅니다.**
- SP1의 벤치마크 파일 `sp1-scoring/artifacts/benchmark/3000-mixed.json`을 그대로 넣어도 1.61–1.74 s가 나오고, 판정도 같습니다(`[3750,0,0,0,0,0]`, 1,000,000점).
- GKR 수치는 **컨트랙트에 바로 제출할 수 있는 proof**까지의 시간입니다(witness 생성 포함).
- SP1 core proof는 EVM에서 검증할 수 없고, Groth16으로 감싸는 데 시간이 더 듭니다.

대가는 두 가지입니다.
- 온체인 검증 gas가 SP1 Groth16(약 0.3M)보다 큽니다. 모드 B 기준 3,000노트 한 번 제출에 **약 2.4M gas**입니다.
- 보안이 **powers-of-tau SRS**(universal, 1-of-N 신뢰)에 의존합니다. 회로별 trusted setup은 없습니다.

| 문서 | 내용 |
|---|---|
| [SPEC.md](SPEC.md) | 규범 명세: 관계식, 프로토콜, 인코딩, 컨트랙트, 건전성 논증, 테스트 의무 |
| [gkr/SECURITY.md](gkr/SECURITY.md) | 요청하신 `swjng/gkr` 저장소의 보안 결함과 수정 |
| [gkr/BASELINE.md](gkr/BASELINE.md) | 수정한 upstream prover의 성능 측정 |

## 구조

```
 Trusted controller (FPGA+SE050)        Prover (신뢰 불필요한 sidecar)             Ethereum
 ───────────────────────────────        ─────────────────────────────           ───────────────────────────────
 switch → timestamp·seq                  witness: 레인별 timeline,                ManiaGkrRegistry
 SHA-256 trace chain (V1 그대로)          큐 상태기계, 판정 등급                    ├ devices / sessions (SP1과 동일)
 [모드 B] trace의 KZG commitment C_E      1. ADV 전체를 KZG commit                  ├ registerChart: 채보 bytes 온체인 검증
 SE050: sign(sessionDigest) ────────────▶ 2. logUp-GKR (모든 multiset·lookup)       │    + KZG commitment 일치 증명
                                          3. row sumcheck (제약식+leaf+카운트)      └ submit* ─▶ GkrScoreVerifier
                                          4. opening reduction sumcheck                  ├ keccak transcript
                                          5. batched Zeromorph opening                   ├ GKR·sumcheck 검증 (Yul)
                                                                                         ├ GkrRelation (제약식 평가)
                                                                                         └ Zeromorph (ecMul·pairing)
```

**증명 내용.** 등록된 장치가 서명한 trace와 온체인에서 검증·등록된 채보가 있을 때, 제출된 판정
카운트가 `core::evaluate`의 결과와 정확히 같습니다. V1의 모든 유효성 규칙도 성립합니다.
점수와 MISS 수는 컨트랙트가 카운트로부터 계산합니다.

**채점을 회로로 옮긴 방법**(SPEC §5–6):
- 각 레인에서 노트 open(`s−W`), 이벤트(`t`), close(`s+W` 직후)를 시간순으로 병합한 **timeline 표**를 만듭니다.
- 그 표 위의 큐 `[F, O)` 상태기계가 V1의 notelock, 만료, hold 판정을 정확히 재현합니다.
- 정렬은 byte-limb range check(logUp lookup)로 확인합니다.
- 행 사이 상태 연결, 표 간 결합(trace ↔ timeline ↔ 채보의 hit/release), 등급 경계는 모두 logUp multiset 하나로 증명합니다.
- 정렬·탐색 같은 **순차 계산은 회로에 넣지 않습니다.** prover가 만든 표가 올바른지만 데이터 병렬로 검사하므로 회로가 얕습니다.
- 여러 등가성 테스트로 확인했습니다. 무작위 입력 3,000개(잘못된 입력 포함)에서 `core::evaluate`와 모두 일치했습니다.

**제로 지식은 아닙니다.** SP1 버전처럼 privacy를 주장하지 않습니다.

### Trace 바인딩 모드 두 가지

| | 모드 A `submitCalldata` | 모드 B `submitCommitted` |
|---|---|---|
| 하드웨어 | **변경 없음**: SP1 V1 SHA-256 chain과 digest V1 그대로 | 장치가 trace의 KZG commitment를 추가로 계산하고, digest V2에 서명 |
| 온체인 데이터 | 이벤트당 14 B calldata를 올리고, 컨트랙트가 SHA-256을 다시 계산 | trace를 올리지 않음 |
| trace 평가 | 컨트랙트가 MLE를 직접 계산: O(n) | batched opening에 포함: O(log n) |
| 3,000노트 tx gas | 8.38M | **2.36M** |

- 모드 B에서는 FPGA가 이벤트마다 BN254 G1 fixed-base 스칼라곱을 해야 합니다(작은 스칼라 3개, powers-of-tau 점 `4·2^16`개 필요).
  하드웨어 구현 전까지는 **소프트웨어 장치로만 테스트**했습니다. 소프트웨어 계산 시간은 3,000노트 6.5 ms, 10,000노트 17 ms입니다.
- 모드 A는 현재 하드웨어 명세 그대로 동작합니다.

### 신뢰 가정 (SP1 버전 대비)

| | SP1 | 이 구현 |
|---|---|---|
| 장치 등록, 세션 개설 | organizer | 동일 |
| 채보 | organizer가 chartHash를 승인하고, guest가 검증 | 컨트랙트가 **채보 bytes를 직접 검증**합니다. chartHash는 SP1과 같고, commitment가 채보와 일치하는지도 증명합니다(§8.1). |
| 증명 시스템 | SP1 verifier와 SP1 Groth16 setup | **powers-of-tau SRS**(universal)와 Zeromorph |
| Fiat–Shamir | SP1 내부 | keccak transcript가 statement와 모든 메시지를 흡수합니다(§7.1) |

`mania-gkr srs --ptau <file>`는 공개 ceremony의 `.ptau`를 읽어 검증한 뒤 SRS로 사용합니다.
PSE Perpetual Powers of Tau(`ppot_0080_*.ptau`, 기여자 80명)로 SRS를 만들어 증명→검증까지 확인했습니다.
검증 항목은 on-curve, generator, pairing 일관성입니다.
벤치마크에 쓴 `--smax 22` SRS는 τ가 알려진 **개발용**입니다. 운영에서는 `ppot_0080_22.ptau` 이상으로 만든 SRS와 그 G2 키로 컨트랙트를 배포해야 합니다.

## 디렉터리와 실행

| 경로 | 내용 |
|---|---|
| `../crates/gkr-evm/` | Rust crate `mania-gkr`: field/transcript/MLE, logUp-GKR, Zeromorph KZG, 채점 관계식, witness, prover, native verifier, CLI |
| `../crates/prove-server-evm/` | 단일 binary HTTP 서버: play JSON을 보내면 GKR proof를 JSON으로 반환 ([문서](../crates/prove-server-evm/README.md)) |
| `contracts/` | `GkrScoreVerifier`(핵심 검증), `GkrRelation`(제약식 평가, EIP-170 때문에 분리), `ManiaGkrRegistry`(장치·채보·세션·제출), Foundry 테스트 |
| `gkr/` | `swjng/gkr` fork: 보안 수정, `patches/`, 재현 스크립트, baseline. 이 workspace에서 제외된 독립 crate입니다. |
| `artifacts/` (gitignore) | 개발용 SRS, Foundry fixture, 벤치마크 원본(`artifacts/benchmark/*.json`) |

```sh
cd gkr-scoring
cargo test --release --locked -p mania-gkr -p mania-gkr-prove-server            # 단위, 차등, 변조, 악성 witness 테스트
cargo build --release --locked -p mania-gkr -p mania-gkr-prove-server
../target/release/mania-gkr srs --smax 22 --out artifacts/dev-srs-22.bin      # INSECURE 개발용, 약 5초, 268 MB
../target/release/mania-gkr export-forge --srs artifacts/dev-srs-22.bin --out artifacts/forge
(cd contracts && forge test -vv)                                             # 온체인 검증, 변조, FFI end-to-end, gas
../target/release/mania-gkr bench --srs artifacts/dev-srs-22.bin --cases 500,1500,3000,3000ln,10000 --reps 5 \
    --out artifacts/benchmark/summary.json
../target/release/mania-gkr prove --srs artifacts/dev-srs-22.bin --input ../fixtures/demo.json --mode a
```

`prove-session`은 컨트랙트가 발급한 세션 header(`abi.encode(Header)`)로 proof를 만듭니다.
Foundry end-to-end 테스트가 이 명령을 FFI로 호출하고, 운영에서는 sidecar가 같은 역할을 합니다.

## 테스트 결과

- **Rust** (`cargo test --release --locked -p mania-gkr -p mania-gkr-prove-server`): 단위 17개와 통합 9개가 통과했습니다. 실제 ceremony `.ptau` 로드 테스트는 `MGKR_PTAU`를 설정하면 실행되고, 이번에 실행해 통과했습니다.
  - 무작위 3,000개 입력에서 timeline 카운트와 유효성 판정이 `core::evaluate`와 전부 일치했습니다.
  - 모든 honest witness에서 모든 행의 모든 제약식이 0이었고, logUp 합도 0이었습니다.
  - 약 50개 입력은 두 모드 모두 prove→verify까지 수행했습니다.
  - 모든 테이블 다항식이 차수 4 이하임을 검사합니다.
  - 악성 witness 5종이 전부 거부되었습니다: 판정 등급 위조, hit 누락, 매칭 은폐, timeline 행 순서 조작, 범위 밖 limb.
- **Foundry** (`forge test`): 11개가 통과했습니다.
  - 내보낸 14개 case를 온체인에서 검증했고, 판정·점수가 `core::evaluate`와 같았습니다.
  - 다음 변조는 전부 거부되었습니다: proof 각 구간의 ±1, 잘라내거나 덧붙인 proof, non-canonical 값, statement 변조, calldata trace 변조, 다른 trace commitment, 모드 혼동.
  - 채보 등록: chartHash가 SP1과 같았습니다. 위조 commitment, 사후 변경, 정렬 위반, 권한 없음, 중복 등록은 거부되었습니다.
  - 두 모드의 end-to-end: 컨트랙트가 header를 발급하고, Rust가 proof를 만들고, Solidity digest가 Rust와 일치하고, 장치가 서명하고, 점수가 기록되었습니다.
    잘못된 키, relayer 소유권, replay, revoke, 만료도 확인했습니다.

## 벤치마크 상세

- 시간은 5회 중 중앙값이고 witness 생성을 포함합니다. SRS 로드(60 ms)는 제외했습니다.
- proof 크기는 calldata word 수 × 32입니다.
- 원본: `artifacts/benchmark/summary.json`(GKR), `artifacts/benchmark/sp1-core-baseline.json`(SP1).

| 노트 | prove A / B | 그중 Zeromorph opening | GKR | row sumcheck | native verify A / B | proof |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 381 / 376 ms | 173–191 ms | 62 ms | 105 ms | 5.4 / 3.1 ms | 21.8 KB |
| 1,500 | 910 / 920 ms | 563 ms | 94 ms | 160 ms | 6.7 / 3.3 ms | 25.7 KB |
| 3,000 | 1,640 / 1,550 ms | 1.05–1.11 s | 131 ms | 211 ms | 8.8 / 3.5 ms | 27.8 KB |
| 3,000 LN | 1,619 / 1,608 ms | 1.09–1.12 s | 129 ms | 212 ms | 8.8 / 3.6 ms | 27.8 KB |
| 10,000 | 4,768 / 4,446 ms | 3.07–3.14 s | 268 ms | 461 ms | 16.9 / 3.8 ms | 32.3 KB |

- 병목은 Zeromorph opening, 즉 크기 N = 2^A dense MSM 약 3회입니다. 모드 A는 verifier가 trace MLE를 직접 계산하므로 native verify가 더 깁니다.
- SP1 core proof는 약 2.8–4.4 MB이고, SP1 Groth16 proof는 356 B입니다.

### 온체인 gas (Foundry; tx 총 gas = 실행 + 21,000 + EIP-2028 calldata)

| | 500노트 | 3,000노트 |
|---|---:|---:|
| 모드 B `submitCommitted` | 2.07M | **2.36M** |
| 모드 A `submitCalldata` | 3.05M | 8.38M |
| `registerChart` (채보당 1회, 실행 gas) | 1.5M | 6.9M |
| 참고: SP1 Groth16 `submit` (기존 Sepolia 실측) | 0.30M | 0.30M |

- 모드 B의 구성(3,000노트 기준):
  - calldata 약 0.46M
  - GKR 약 0.43M (Yul로 전환한 뒤)
  - 제약식 평가 약 0.34M
  - Zeromorph 약 0.31M (ecMul 26회, pairing 3쌍)
  - 나머지는 sumcheck, transcript, 세션 처리입니다.
- 관계식 평가와 채보 등록을 Yul로 옮기면 추가로 줄일 수 있습니다. 성능 병목은 계산량이 아니라 Solidity 오버헤드입니다.

## `swjng/gkr` 저장소: 사용 방식과 보안 수정

요청대로 `swjng/gkr`(commit `1693f3f`)를 가져와 [`gkr/`](gkr/)에 fork했습니다. 모든 보안 결함을 수정했습니다(GKR-11만 설계 문제로 문서화).
patch는 `gkr/patches/0001–0012`에 있고(`git am`으로 재현 가능), 결함 목록·공격 방법·수정·테스트는 [gkr/SECURITY.md](gkr/SECURITY.md)에 있습니다.

**주요 결함.** 수정 전에는 upstream verifier들이 거짓 statement의 proof를 받아들였습니다.

| ID | 심각도 | 내용 |
|---|---|---|
| GKR-01 | Critical | Fiat–Shamir challenge가 "현재 round 다항식의 MiMC"뿐이었습니다. circuit, 입출력, 이전 메시지에 묶이지 않았습니다. |
| GKR-02 | Critical | Rust prover의 출력 점이 `z0 = 0`으로 고정이었습니다. 그래서 출력 게이트 0만 검사되었습니다. |
| GKR-03/04/05/07 | Critical | circom verifier 결함 네 가지가 겹쳐 **모든 circuit에서 all-zero proof를 받아들였습니다.** `repro/upstream-zero-proof/run.sh`로 직접 재현했습니다. <ul><li>초기 claim이 0으로 하드코딩되어 D를 쓰지 않았습니다.</li><li>challenge와 point가 prover가 마음대로 넣는 입력이었습니다.</li><li>wiring 검사가 없었습니다.</li><li>입력층 평가가 제약 없는 `<--`였습니다.</li></ul> |
| GKR-05/06/09 | Critical/High | Python verifier가 prover가 제공한 `f`, add/mult, k, z를 신뢰했습니다. `v==1`이면 조기 수락하는 경로도 있었습니다. |
| GKR-08 | High | round 다항식의 차수 제한이 없었습니다. |
| GKR-10 | High | R1CS 상수가 입력층에 있어 prover가 바꿀 수 있었습니다. |
| GKR-12~16 | Medium~Info | 외부 도구 오류를 무시하고 stale 파일을 재사용했습니다. 이름이 충돌할 수 있었습니다. Groth16 mock setup이 있었습니다. 무한 재귀와 panic이 있었습니다. MiMC 구현이 circom과 불일치했습니다. |
| GKR-11 | High (**미수정**) | 재귀 aggregation에서 이전 라운드의 공개 입력이 최종 proof에 묶이지 않습니다. aggregation 설계를 바꿔야 하는 문제라 문서화만 했습니다. |

**수정 내용:**
- stable Rust로 빌드되게 했습니다(halo2curves 0.2.1 → 0.10).
- chained MiMC7 transcript(Rust·Python·circom 공통 known-answer vector)를 도입했습니다.
- 새 Rust verifier를 추가했습니다(upstream에는 없었음).
- circom verifier를 circuit별로 생성하는 방식으로 교체하고, 모든 연산에 제약을 걸었습니다.
- 도구 오류는 이제 실패로 처리합니다.

**직접 재확인한 결과:**
- Rust: 15개 통과.
- Python: 10개 통과(upstream verifier가 거짓 출력을 받아들이는 `LegacyExploit` 포함).
- circom: 1개 통과(honest proof는 수락, 위조 변형은 전부 거부).
- upstream all-zero forgery 재현 스크립트가 원본에서 실제로 수락되는 것을 확인했습니다.

**채점에 upstream prover를 그대로 쓰지 않은 이유.** upstream prover는 모든 다항식을 monomial 목록으로 다룹니다.
그래서 회로 크기가 두 배가 될 때마다 시간이 4–5배로 늘어납니다([gkr/BASELINE.md](gkr/BASELINE.md)).
같은 모양의 회로에서 비교한 결과는 다음과 같습니다(`cargo run --release --example gkr_scaling`).

| 이진 트리 leaf 수 | 수정한 upstream prover | 이 엔진의 fractional-sum GKR (노드당 연산이 더 많음) |
|---:|---:|---:|
| 2^10 | 263 ms | 13 ms |
| 2^12 | 6.4 s | 24 ms |
| 2^14 | **132 s** | **35 ms** |
| 2^20 | (불가능) | 168 ms |
| 2^22 | (불가능) | 368 ms |

채점 회로는 leaf가 약 2^19–2^21개이므로 upstream prover로는 증명할 수 없습니다.
그래서 같은 프로토콜 계열(sumcheck 기반 GKR: layer별 sumcheck, 두 claim을 하나로 합치는 line 축약)을 쓰되,
**dense 평가표와 선형 시간 sumcheck로 데이터 병렬 prover를 새로 구현**했습니다.
fork는 보안을 수정한 baseline이자 참조 구현으로 남겨 두었습니다.

**라이선스 주의.** upstream에는 **LICENSE 파일이 없습니다.** fork를 공개하거나 재배포하려면 작성자의 허락이 필요합니다.
`../crates/gkr-evm/`에는 upstream 코드를 복사하지 않았습니다.

## 한계와 남은 일

- **SRS:** 개발용 SRS(`srs --smax`)는 τ가 알려져 있어 proof를 위조할 수 있습니다. 운영에는 반드시 `srs --ptau ppot_0080_22.ptau --smax 22`처럼 ceremony SRS를 쓰세요(로더 구현·검증 완료, 약 4.8 GB 파일 필요).
- **모드 B 하드웨어:** 모드 B는 FPGA의 KZG commitment 계산을 전제로 합니다. 하드웨어 팀과 먼저 확인해야 합니다. 그때까지는 모드 A를 쓰면 됩니다.
- **Gas:** SP1 Groth16보다 약 8배 큽니다. 다음 방법으로 줄일 수 있습니다.
  - 관계식 평가와 채보 등록을 Yul로 옮기기
  - 초반 GKR layer를 묶어 proof 크기를 줄이기
  - 모드 B proof를 Groth16으로 한 번 감싸기(prove 시간과 trusted setup 사이의 trade-off)
  - L2에 배포하기
- **감사:** 외부 감사를 받지 않았습니다. 관계식이 V1과 같다는 것은 논증(SPEC §5.3)과 대규모 차등 테스트로 뒷받침합니다.
- **범위 밖:** escrow/payout, 실제 USB·FPGA 연동, DER→(r,s,v) 변환은 SP1 버전과 마찬가지로 다루지 않습니다.
