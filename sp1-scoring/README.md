# SP1 osu!mania scoring prototype

하드웨어가 기록한 전체 입력과 고정된 채보를 Rust에서 채점하고, **동일한 함수를
SP1 zkVM에서 실행해 점수 계산의 정확성을 증명**하는 독립 프로토타입입니다.
기존 osu!lazer 클라이언트 코드는 수정하지 않습니다.

```
canonical chart + session header + complete trace/footer
                         ↓
         SP1: commitment 검증 → 입력 검증 → 정수 채점
                         ↓
        proof + 공개 출력(점수, 채보/root/session binding)
                         ↓
  Solidity: 등록된 장치 서명 + 열린 세션 + SP1 proof 검증
                         ↓
               세션당 한 번 점수 기록
```

**중요:** proof 단독으로는 실제 하드웨어 입력을 증명하지 않습니다. 임의 입력에도
올바른 계산 proof는 만들 수 있습니다. `ManiaScoreVerifier`가 사전 등록된 장치의
서명과 세션을 확인해야 하드웨어 출처까지 연결됩니다. 포함된 fixture는 **서명 없는
합성 입력**입니다. FPGA/SE050, USB, 실제 클라이언트 입력 수집, escrow/payout은 미구현입니다.

## 구현 범위

| 경로 | 역할 |
|---|---|
| `core/` | 4K tap/hold, 정수 판정, canonical hashing, 전체 trace 검증 |
| `program/` | SP1 guest: `evaluate()` 실행 후 512-byte Solidity ABI 공개 출력 |
| `host/` | 실제 zkVM 실행, local CPU core/Groth16 proving, 저장된 proof 재검증 |
| `server/` | SP1 proving HTTP API: job 큐·상태 조회·proof 다운로드·인증·재시작 처리 |
| `cli/` | SP1 설치 없이 네이티브 채점 |
| `contracts/` | 장치 등록·세션 생성·장치 서명/SP1 proof 검증·재사용 차단 |
| `contracts/script/Sepolia.s.sol` | Sepolia 배포·장치 등록·세션 생성/조회·proof 제출 |
| `scripts/` | strict `.osu` 변환, 합성 fixture, cycles benchmark |
| `SPEC.md` | 판정·hold·notelock·인코딩·보안 경계의 정확한 명세 |

`OSUMANIA_ONCHAIN_RULESET_V1`은 OD5의 고정 hit window와
`320/300/200/100/50/0` 가중치를 사용합니다. tap은 한 판정, hold는 head/tail 두 판정이며,
전체 채보의 가능한 점수로 정규화합니다. **공식 lazer 점수 또는 완전한 판정 호환성을
주장하지 않습니다.** 규칙을 바꾸면 ruleset ID와 guest verification key를 함께 바꿔야 합니다.

## 빠른 실행 — Rust만 필요

저장소 루트에서:

```sh
cd sp1-scoring
cargo test --locked
cargo run --release --locked -p mania-scoring-cli -- fixtures/demo.json
python3 -m unittest discover -s scripts -v
forge test --root contracts -vv
```

샘플 예상 결과:

```
notes: 4, events: 8
PERFECT: 4, GREAT: 1, GOOD/OK/MEH/MISS: 0
achieved_points: 1580 / maximum_points: 1600
score: 987500
```

만점 샘플은 `fixtures/perfect.json`입니다. 같은 채보를 모두 PERFECT로 판정하여
**정확히 1,000,000점**(5 PERFECT, 1600/1600)을 얻습니다. tap/hold/mixed를 각각
최대 10,000노트까지 테스트했고 실제 SP1 core proof도 생성·검증했습니다.

```sh
cargo run --release --locked -p mania-scoring-cli -- fixtures/perfect.json
host/target/release/mania-sp1-host core fixtures/perfect.json artifacts/perfect
```

`fixtures/demo.expected.json`은 Rust/Solidity ABI와 장치 서명 digest의 공통 golden
vector입니다. `trace-vectors.json`은 Python에서 독립 계산한 0/1/31/32/33/64/65개
event의 hash-chain 경계 벡터입니다.

## 실제 SP1 실행과 proof

HTTP로 proving을 요청하려면 [웹 서버 실행 및 API 문서](server/README.md)를 참고하세요.
기존 host를 빌드한 다음 `cargo run --release --locked -p mania-proof-server`로 실행하고,
`python3 scripts/prove_http.py fixtures/perfect.json --out artifacts/http-perfect`로
요청·진행 상태 조회·proof 다운로드를 할 수 있습니다.

SP1 SDK/build/zkVM은 **6.8.0**으로 고정했고 세 Cargo.lock을 포함했습니다.
Rust/rustup, `protoc`, Succinct toolchain이 필요합니다. 설치는
[공식 SP1 설치 문서](https://docs.succinct.xyz/docs/sp1/getting-started/install)를 참고하세요.
Rust 1.94.1, Succinct rustc 1.94.0-dev, Apple Silicon에서 확인했습니다.

```sh
# SP1 toolchain 설치 후, sp1-scoring/에서:
bash scripts/build_sp1.sh

# 실제 RISC-V 실행 + 네이티브 결과와 전체 공개 출력 비교; proof를 만들지는 않음
host/target/release/mania-sp1-host execute fixtures/demo.json artifacts/demo

# 실제 CPU core proof 생성 + 암호학적 검증 + proof.bin/proof.json 저장
host/target/release/mania-sp1-host core fixtures/demo.json artifacts/demo

# 저장된 proof를 현재 guest 및 지정한 입력/세션에 대해 재검증
host/target/release/mania-sp1-host verify fixtures/demo.json artifacts/demo

# EVM용 Groth16 proof. 실행 중인 Docker와 추가 proving 리소스/아티팩트 필요
host/target/release/mania-sp1-host groth16 fixtures/demo.json artifacts/evm
```

`build_sp1.sh`는 임시 rustup proxy를 사용해 Homebrew Rust와의 충돌을 피하며
사용자의 shell 설정은 변경하지 않습니다. SP1을 설치하지 않고 네이티브 테스트만
실행할 수 있도록 guest/host는 별도 Cargo workspace입니다.

host는 로컬 `light`/`cpu` client를 명시적으로 선택합니다. `SP1_PROVER=mock`이나
`network` 환경변수로 가짜 proof 또는 유료 원격 proving으로 바뀌지 않습니다.
`execute` 결과는 `proofGenerated:false`, 성공한 proving 결과만 `true`입니다.
Core proof의 JSON `proof` 필드는 `null`입니다. Core proof는 EVM에 제출할 수 없습니다.
Groth16 성공 시에만 `proof.json`의 `proof`, `publicValues`, `vkey`를 제출에 사용합니다.

## 채보와 입력 준비

```sh
# native 4K, OD5, tap/hold .osu → canonical chart
python3 scripts/make_fixture.py --osu fixtures/demo.osu --chart-only --out artifacts/chart.json

# 위 채보를 완벽히 치는 합성 입력 생성 (실제 플레이나 하드웨어 서명이 아님)
python3 scripts/make_fixture.py --osu fixtures/demo.osu --out artifacts/synthetic.json
cargo run --release --locked -p mania-scoring-cli -- artifacts/synthetic.json

# 재현 가능한 큰 입력
python3 scripts/make_fixture.py --notes 3000 --ln-heavy --out artifacts/ln.json
```

변환기는 native `Mode:3`, `CircleSize:4`, `OverallDifficulty:5`만 허용합니다.
slider/spinner, 다른 OD, 같은 lane의 중복/겹치는 노트, 마이크로초로 정확히 표현할 수
없는 시간은 거부합니다. 오디오·메타데이터는 채보 commitment에 포함되지 않습니다.
실제 사용 시 organizer가 canonical chart를 승인하고 host의 표시 채보와 맞춰야 합니다.

실제 장치 연결에서는 contract에서 열린 세션의 `Header`를 받아 controller를 arm하고,
명세대로 timestamp·sequence·chunk hash를 생성해야 합니다. 장치는 **자신이 계산한
최종 sessionDigest만** 서명해야 합니다. 합성 fixture의 header나 hash를 바꾸는 것으로
실제 장치 서명을 대체할 수 없습니다. JSON byte arrays와 고정 폭 wire encoding의
차이는 [SPEC.md](SPEC.md)에 정의되어 있습니다.

## 온체인 연결

실행 가능한 Sepolia 스크립트와 전체 명령은 **[SEPOLIA.md](SEPOLIA.md)**를 참고하세요.
`.env.example`에 public 설정을 넣고 encrypted Foundry keystore로 서명합니다.
`bash scripts/sepolia.sh deploy|register|open|export|submit`은 기본 시뮬레이션이며
`--broadcast`를 붙이면 실제 Sepolia에 전송합니다. 배포 전에
`mania-sp1-host vkey artifacts/vkey.json`으로 program key를 추출할 수 있습니다.

1. 호환되는 실제 SP1 verifier 주소와 **이번 guest ELF에서 얻은 vkey**로
   `ManiaScoreVerifier`를 배포합니다. 공식 주소는
   [SP1 온체인 검증 문서](https://docs.succinct.xyz/docs/sp1/verification/contract-addresses)를
   통해 대상 chain/version에 맞게 확인해야 합니다.
2. organizer가 `setDevice(signer, bitstreamHash, true)`로 실제 trusted device를 등록합니다.
3. organizer가 승인한 `chartHash`로 `openSession(...)`을 호출합니다. `getSession(id)`의
   header를 그대로 장치에 전달합니다. deadline에는 플레이와 proving 시간을 포함합니다.
4. trace로 Groth16 proof를 생성하고, 장치에서 raw SHA256 digest에 대한 서명을 받습니다.
5. 누구든 `submit(publicValues, proof, deviceSignature)`로 relay할 수 있습니다.
   기록 소유자는 열린 세션의 player이며, 세션은 한 번만 성공합니다.

`deviceSignature`는 `r || s || v` 65 bytes, low-s, v=27/28입니다.
`personal_sign`은 사용할 수 없습니다. SE의 DER 서명을 받아 변환하는 driver는
포함하지 않습니다. organizer가 arbitrary laptop signer를 등록하면 하드웨어 보장은
사라집니다. contract의 등록 권한은 이러한 enrollment 신뢰를 명시한 것입니다.

Foundry 테스트는 **명시적인 mock SP1 verifier**로 application binding, 실제 ECDSA
서명, replay·변조·만료·권한·revocation·Rust/Solidity 인코딩을 검증합니다.
이 테스트의 gas 수치는 실제 Groth16 검증 gas가 아닙니다.

## 검증 결과와 벤치마크

2026-09-22 로컬 실행:

- Rust 15개, Python 8개, Solidity 11개 테스트(여러 시나리오를 포함한 Sepolia workflow 포함).
- 실제 SP1 guest 빌드·실행, local core proof 생성·검증 성공.
- 샘플 core proof 파일 약 2.78 MB. 이는 압축된 EVM proof 크기가 아닙니다.
- 아래 네 경우 모두 네이티브와 SP1의 512-byte 공개 출력이 완전히 일치했습니다.

| 채보 | 노트 | 입력 이벤트 | zkVM cycles | 실행 시간 (ms) |
|---|---:|---:|---:|---:|
| mixed | 500 | 1,000 | 2,097,866 | 42 |
| mixed | 1,500 | 3,000 | 6,066,968 | 121 |
| mixed | 3,000 | 6,000 | 12,032,069 | 222 |
| all holds | 3,000 | 6,000 | 12,076,319 | 234 |

시간은 단일 로컬 실행 관측값이며 proving 시간이 아닙니다. 샘플 4노트의 core proving과
로컬 검증은 약 12.8초였지만, 이를 큰 채보의 proving 시간으로 외삽해서는 안 됩니다.
**2026-09-22 최초 검증에서는 Groth16 생성·실제 EVM 검증·실제 gas 비용을 측정하지
않았습니다.** 당시 Docker daemon이 실행 중이지 않아 Groth16 wrapping을 실행하지 않았습니다.

재측정:

```sh
python3 scripts/benchmark.py          # native
python3 scripts/benchmark.py --sp1    # native + 실제 zkVM, host 빌드 후 실행
```

결과는 `artifacts/benchmark/summary.json`에 저장됩니다. 모든 proof·빌드 산출물은
gitignore되어 있습니다. 실제 chart trace의 proving 비용과 Groth16 검증 gas를
측정한 뒤 배포 체인과 운영 방식을 결정해야 합니다.

2026-09-23 추가 검증: 인증 웹 서버의 실제 Groth16 생성과 Sepolia 점수 제출까지
성공했습니다. 4노트 합성 만점 입력의 HTTP 요청→다운로드는 272.149초,
점수 제출은 303,951 gas였으며 온체인에 1,000,000점이 저장됐습니다.
소프트웨어 테스트 장치를 사용했습니다. [실행 기록](DEMO_READINESS.md)을 참고하세요.
