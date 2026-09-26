# 코드 전체 구조와 구현 근거

## 1. 검토 범위와 기준

`gkr-scoring`과 `sp1-scoring`의 소스, 테스트, 실행 스크립트, manifest, 규격 문서를 따라 입력→채점→증명→검증→세션 기록 경로를 검토했다. GKR의 별도 upstream fork도 Rust/Python/Circom 구현, converter/aggregation 및 취약점 재현 코드를 읽어 현 엔진과 구분했다. Patch series는 변경 이력으로, 최종 소스는 실제 동작의 기준으로 사용했다.

이는 코드 이해와 handoff를 위한 검토이며 formal verification이나 독립 보안 감사 결과가 아니다. Generated build/dependency/cache, 기존 대형 SRS/benchmark artifacts, 배포 broadcast, 비밀 `.env`는 소스 검토 대상에서 제외했다. Lockfile은 의존성 snapshot으로 취급하며 그 안의 모든 외부 dependency 구현을 검토했다는 의미가 아니다.

[source-manifest.json](source-manifest.json)은 분석 대상 파일별 SHA-256을 기록한다. 분석 시작 시 두 디렉터리는 상위 Git에서 untracked였으므로 상위 HEAD만으로 이 소스 버전을 재현할 수 없다. Manifest에 기록한 HEAD는 작업 환경의 참고 정보다. 이번에 추가한 handoff 문서·벡터·exporter는 snapshot 목록에서 분리했다. GKR README는 handoff 진입 링크를 추가한 최종 상태로 기록했다.

## 2. 실제 실행 경로

```text
공통 V1 데이터·채점 의미: scoring/core
                         │ path dependency
                         ▼
gkr-scoring/engine/scoring/witness ──► relation + layout
                │                           │
                └──────────► prover ◄───────┘
                                │
            field/MLE/poly/transcript/logup_gkr/zeromorph
                                │
                          encode::proof_words
                                │
                   GkrScoreVerifier + GkrRelation
                                │
                       ManiaGkrRegistry

gkr-scoring/gkr/  = 별도 workspace의 upstream 연구용 fork
sp1 host/program/server = SP1 실행 경로, GKR proof 경로가 아님
```

### A/B의 차이

| 항목 | 모드 A / Calldata=1 | 모드 B / Committed=2 |
|---|---|---|
| 장치 hash/signature | V1, SHA root | V2, SHA root + C_E |
| 전체 trace | calldata로 제출 | sidecar가 보유, calldata에는 없음 |
| trace와 proof의 연결 | verifier가 trace MLE를 직접 평가 | 장치가 서명한 C_E의 opening |
| SHA root 검사 | registry가 calldata에서 재계산 | registry는 서명된 root를 사용, trace에서 재계산하지 않음 |
| 장치 추가 계산 | 없음 | BN254 G1 누적 commitment |

## 3. 현 GKR 엔진 파일별 역할

모든 경로는 `gkr-scoring/` 기준이다.

| 파일 | 핵심 역할과 읽어야 할 연결 |
|---|---|
| `Cargo.toml`, `engine/Cargo.toml`, `Cargo.lock` | engine 단일 workspace, 별도 `gkr` 제외, halo2curves/Rayon/hash 의존성과 공통 core path dependency |
| `engine/src/lib.rs` | 모듈 공개 경계 |
| `engine/src/field.rs` | BN254 Fr/Fq/G1/G2 타입, canonical BE 변환, identity encoding, MSM, EVM G2 좌표 순서 |
| `engine/src/transcript.rs` | Keccak256 state, word batch absorb, squeeze→Fr reduction; SHA 장치 protocol과 별개 |
| `engine/src/mle.rs` | LSB-first dense MLE, fold, eq table/eval, zero padding의 평가 인자, ceil log2 |
| `engine/src/poly.rs` | 작은 차수 다항식의 evaluation/interpolation; sumcheck에서 g(1)을 생략/복원 |
| `engine/src/logup_gkr.rs` | 분수 합 트리의 prover/verifier, degree-3 sumcheck, layer 수/round 수/최종 claim 검사 |
| `engine/src/zeromorph.rs` | SRS 생성/import/raw save/load/VK ID, univariate KZG commitment, multilinear opening 변환, quotient 및 degree 검증 |
| `engine/src/scoring/mod.rs` | mode/statement/proof/chart record, transcript statement 순서, 정수 점수 계산 |
| `engine/src/scoring/api.rs` | 편의 prove/verify/statement, software device_trace_commitment; capture 인증 계층은 아님 |
| `engine/src/scoring/session.rs` | V2 policy/digest, canonical chart bytes, chart commitment 등록 proof 생성/검증 |
| `engine/src/scoring/witness.rs` | 채보/입력 검사, lane timeline 실행, chart/trace/byte table 작성, logUp multiplicity, reference 차등 비교 |
| `engine/src/scoring/relation.rs` | 각 table의 컬럼 index, transition·boolean·range·judgement 제약, lookup fingerprint와 slot, 판정 카운트 다항식 |
| `engine/src/scoring/layout.rs` | table shape로 leaf slot·advice block 배치 결정, claim 컬럼 순서, opening 변수 수 |
| `engine/src/scoring/prover.rs` | advice commitment→logUp-GKR→row sumcheck→claim reduction→batched Zeromorph; CPU 단계별 timing |
| `engine/src/scoring/verifier.rs` | public bound/shape/round/claim 검사, A의 trace 직접 평가 또는 B opening 검증, MISS·점수 반환 |
| `engine/src/scoring/encode.rs` | `uint256[]` proof word 순서와 strict decode; laneBits/counts는 별도 ABI |
| `engine/src/testutil.rs` | 합성 benchmark input, 경계/hold case, reference header/footer 생성 |
| `engine/src/forge.rs` | chart/VK/proof fixture export, Foundry ABI header 파싱, 세션 header로 합성 trace를 재바인딩 |
| `engine/src/bin/mania-gkr.rs` | `srs`, `bench`, `prove`, `export-forge`, `prove-session`; HTTP/실장치 capture server는 없음 |
| `engine/examples/gkr_scaling.rs` | fractional GKR standalone scaling 측정, 전체 input device 비용과 별개 |
| `engine/tests/end_to_end.rs` | 양 모드 정직 proof, randomized reference 차등, 변조/악성 witness/직렬화 거부 |
| **신규** `engine/examples/fpga_vectors.rs` | device encoding/SHA/KZG/digest vectors 및 canonical G1 ROM exporter |

`src/bin/mania-gkr.rs`는 broad `bin/` ignore 패턴 때문에 기본 file listing에서 빠질 수 있다. 검토 inventory는 ignored 파일을 포함해 확인했다.

### Solidity

| 파일 | 역할 |
|---|---|
| `contracts/src/GkrMath.sol` | Fr 상수, ceil log2, eq/zero-padding/id/step MLE 및 degree 2/3/4 interpolation |
| `contracts/src/GkrRelation.sol` | Rust relation에 대응하는 table constraints/slots/public columns 평가; contract 크기 때문에 분리 |
| `contracts/src/GkrScoreVerifier.sol` | SRS VK와 srsId, proof parser, Keccak transcript, shape·GKR·row/reduction sumcheck·Zeromorph 검사, G1/pairing precompile 호출, chart 등록 검증 |
| `contracts/src/ManiaGkrRegistry.sol` | organizer, device/chart/session, V1/V2 digest, traceRoot, ECDSA 검사, mode별 제출·소비·점수 저장 |
| `contracts/test/GkrScore.t.sol` | Rust fixture/FFI 교차 검증, proof/statement 변조, chart/session lifecycle, gas |
| `contracts/test/RelationGas.t.sol` | 관계식 평가 gas 측정 |
| `contracts/foundry.toml` | compiler/optimizer/FFI 및 artifact 경로 설정 |

채점 proof만 통과시키는 `GkrScoreVerifier`와 장치 서명/세션을 검사하는 `ManiaGkrRegistry`는 역할이 다르다. 장치 header의 `verifier` 필드에는 후자의 주소가 들어간다.

## 4. SP1에서 이해에 사용한 내용

아래 구현은 **handoff할 시스템에 추가하는 구성요소가 아니다.** GKR이 보존해야 하는 V1 의미와 기존 테스트 관행을 확인하는 데 사용했다.

| 원본 `sp1-scoring/` 파일군 | 이해한 역할 / GKR에 주는 근거 |
|---|---|
| `core/src/lib.rs`, `core/tests/scoring.rs` | Chart/InputEvent/SessionHeader/Footer/PlayInput, canonical SHA, 입력 유효성, 4-lane deterministic evaluator, journal, 판정 경계·hold·최종 expire |
| `cli/src/main.rs` | JSON input validation/evaluation/hash/journal 도구; SP1 proof를 생성하지 않는 native 경로 |
| `program/src/main.rs`, `program/Cargo.toml` | SP1 guest가 input을 읽고 core를 실행한 결과를 public journal로 commit |
| `host/src/main.rs`, `host/build.rs`, `host/Cargo.toml` | guest build/ELF, execute/prove/verify, proof/journal 출력과 비용 측정; GKR verifier에 호환되지 않음 |
| `server/src/main.rs`, `lib.rs`, `process.rs`, `docker.rs`, `tests.rs` | HTTP 요청/작업 상태, 외부 prover process·Docker 실행/출력 처리, API 오류/동시성/timeout 관행 |
| `contracts/src/ManiaScoreVerifier.sol` | SP1 verifier+program identity와 V1 journal를 검증하는 원래 registry 흐름; V2 C_E는 없음 |
| `contracts/script/Sepolia.s.sol`, `test/ManiaScoreVerifier.t.sol`, `test/SepoliaScript.t.sol` | SP1 배포·등록·세션·제출과 테스트; GKR 배포 스크립트로 사용할 수 없음 |
| `scripts/make_fixture.py`, `test_canonicalizer.py` | `.osu`→canonical 4-key chart 변환과 fixture test |
| `scripts/session_input.py` | 세션 정보를 fixture에 넣는 개발용 input 생성; 실제 장치 출처 보증과 구분 |
| `scripts/prove_http.py`, `smoke_http.py` | SP1 HTTP client와 smoke 실행 |
| `scripts/build_sp1.sh`, `benchmark.py` | SP1 toolchain build/CPU proof 측정 |
| `scripts/sepolia.sh`, `receipt_value.py`, `test_sepolia_tools.py`, `unlock_demo_signer.py` | 개발용 chain orchestration, receipt parsing, helper 테스트, demo signer 운용 |
| `fixtures/`, `SPEC.md`, `README.md`, `SEPOLIA.md`, `DEMO_READINESS.md`, `server/README.md` | V1 known-answer data, 공개 필드/입력 신뢰 경계, 기존 demo의 준비 상태 |

공통 core는 `scoring/core`로 옮겨졌다. SP1 host/guest/server는 제거되었고 아래 원본 SP1 설명과 source manifest는 이전 handoff의 역사적 기록이다.

## 5. 별도 upstream fork에서 읽은 내용

`gkr-scoring/gkr/`는 일반 layered arithmetic circuit GKR 및 Circom aggregation 연구 코드다. 현 점수 엔진은 이 converter나 recursive Groth16 경로를 호출하지 않는다.

| 파일군 (`gkr/` 아래) | 역할과 구분점 |
|---|---|
| `rust/src/gkr.rs`, `gkr/builder.rs` | 일반 circuit/게이트 wiring, layered builder, fixed input positions |
| `gkr/prover.rs`, `verifier.rs`, `sumcheck.rs`, `poly.rs` | 일반 GKR, monomial 다항식, degree/shape/input/output 검증; 현 dense fractional GKR와 별개 |
| `gkr/transcript.rs` | circomlib-compatible MiMC7 chained transcript; 현 engine Keccak transcript와 호환되지 않음 |
| `rust/src/convert.rs` | R1CS/witness를 add/mul circuit로 변환, 상수 입력 고정, 제약별 출력 0 확인 |
| `rust/src/aggregator.rs`, `circom_codegen.rs` | 여러 circuit proof를 검증하는 Circom code 생성과 반복 aggregation orchestration |
| `rust/src/file_utils.rs`, `bin.rs`, `lib.rs` | 파일·Circom/node/snarkjs process, feature별 CLI/module 연결 |
| `rust/src/baseline.rs`, `rust/tests/{verifier,circom}.rs`, `rust/t.circom`, `rust/example/` | benchmark, transcript/proof 교차검사, 생성 verifier 검증, aggregation 예제 |
| `python/{gkr,poly,sumcheck,transcript,util,genjson}.py` | 일반 GKR reference와 Rust-compatible transcript/known answers |
| `python/{test_gkr,test_security,legacy_upstream}.py` | fixed verifier 테스트 및 이전 취약 verifier와 공격 재현 |
| `gkr-verifier-circuits/circom/circom/` | constrained MLE/EqTable, sumcheck, transcript, generated verifier template |
| `repro/upstream-zero-proof/` | 수정 전 Circom verifier가 all-zero forged proof를 수락하는 재현; 운영 사용 대상 아님 |
| `patches/0001–0012`, `SECURITY.md`, `UPSTREAM.md`, `BASELINE.md`, README들 | 수정 이력, 출처, 잔여 한계와 과거 실행 증거 |

이 fork의 GKR-11(aggregation의 inner public input 바인딩 부재)은 `SECURITY.md`에서 미해결로 명시되어 있다. 상위 README의 보안 수정 서술을 현 장치 시스템의 전체 보안 인증으로 읽으면 안 된다. Fork의 MiMC/MSB-first 표현을 현 engine의 Keccak/LSB-first 규격에 섞지 않는다.

## 6. 실제 코드 기준으로 주의할 지점

| 지점 | 구현에서 확인한 사실 | 개발 영향 |
|---|---|---|
| `api::prove` | B policy를 덮어쓰고 C_E를 재계산 | device RESULT를 독립 인증·비교하는 adapter 필요 |
| `witness::build_from_input` | reference 계산에 self-consistent 합성 V1 header 사용; 원본 header/chartHash/root 전체 인증 경로가 아님 | proof 생성 성공과 실제 session 인증을 구분 |
| Native `verify` | proof relation 검증, ECDSA/registry 상태 검사는 안 함; A trace의 seq는 MLE 계수가 아님 | mode A seq/SHA는 registry, mode B 출처는 장치/adapter 책임 |
| `forge::prove_session` | 합성 input에 header를 바인딩하고 root 재계산 | 실제 USB adapter로 오인하지 않음 |
| Mode B root | 서명에 포함되나 proof 안에서 SHA를 실행하지 않음 | 장치 SHA/KZG single-stream 강제 |
| Timeline padding | 끝 state를 유지하는 padding row가 있음 | table 전체 padding을 0으로 만들지 않음 |
| Trace sentinel | row n에 prev-time 및 D까지 gap 등 존재 | committed event polynomial과 witness trace table를 구분 |
| Lane의 `A` state | tap match에서도 최신 matched note를 가리킬 수 있음 | 이름만 보고 “현재 hold만”으로 축소하지 않음 |
| SRS import | on-curve/generator 및 sampled G1 adjacent pairing; 모든 G1 power 전수 검사는 아님 | ceremony/provenance 및 ROM 승인 별도 필요 |
| SRS raw load | `MGKRSRS1` 내부 raw point를 신뢰해 읽음 | 파일을 외부 untrusted 입력으로 취급하지 않음; ROM exporter 사용 |
| SRS ID | VK G2 계열의 Keccak 식별자 | G1 ROM checksum·진본 증명과 구분; V2 header에 직접 포함되지 않음 |
| `total_ms` | witness와 prover 단계 포함; B device C_E 계산·SRS load·chart registration 등 제외 | device 실시간/전체 UX 지연 수치로 사용하지 않음 |
| SRS capacity | 실제 `Shape::opening_vars()`가 기준 | README의 note 수 근사치 대신 lane 분포/이벤트 수로 산정 |
| 이번 test의 ptau | env 미설정으로 조건부 test 조기 반환 | 과거 README의 ceremony 실험과 이번 검증을 구분 |

## 7. 수정 범위

이번 작업은 GKR handoff 문서, 독립 검증 벡터/도구, G1 ROM exporter와 README 진입 링크를 추가했다. 채점 관계식, 증명 규약, contract ABI 또는 SP1 코드는 변경하지 않았다. 수정하지 않은 source의 SHA-256 snapshot과 실행 로그를 함께 제공한다.
