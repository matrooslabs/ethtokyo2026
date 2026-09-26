# FPGA 입력 시뮬레이션 → GKR → Sepolia E2E

모드 B의 실제 GKR proof와 실제 Sepolia transaction을 사용한다. 물리 FPGA/SE050 대신 **가상 시계의 edge stream과 암호화된 소프트웨어 장치 키**를 사용한다. 채점 verifier를 mock하지 않는다. 기본 SRS는 기존 `dev-srs-22.bin`으로, τ가 알려진 개발용이다. 이 실행은 기능·성능 실험이며 실제 하드웨어 보안이나 운영 SRS의 신뢰성을 검증하지 않는다.

## 구성

- [../crates/gkr-evm/examples/fpga_e2e.rs](../crates/gkr-evm/examples/fpga_e2e.rs): fixture/chart/VK 준비, 단일 edge stream의 SHA·순차 KZG 누적, 원본 sealed result를 유지하는 mode B prover adapter.
- [scripts/sepolia_e2e.py](scripts/sepolia_e2e.py): contract 배포, 장치·채보 등록, mined session 조회, capture/sign/prove, 제출 전 eth_call/estimateGas, 실제 전송, 컨펌·이벤트·저장 상태·변조 거부 검사.
- 결과 `run.json`: 모든 거래 receipt, 단계별 시간, gas/fee, 세션 ID, proof 크기, reference 결과와 on-chain 결과.
- 각 run directory: 확정 header, 원본 play, device result, signature, proof, 제출 calldata.

The shared Rust scoring crate is `../crates/scoring-core`; SP1 source and runtime dependencies have been removed. Local defaults are `.env`, `artifacts/software-device.json`, and `artifacts/private-signing/deployer.password` under `gkr-scoring`. Override these paths with CLI flags as needed.

## 준비와 실행

모든 명령은 `gkr-scoring/`에서 실행한다. Foundry, Rust, Python 3.9 이상이 필요하다.

```sh
cargo build --release --locked --example fpga_e2e
forge build --root contracts
../target/release/examples/fpga_e2e prepare \
  --srs artifacts/dev-srs-22.bin --cases 4,500,1500,3000 \
  --out artifacts/fpga-e2e-prepared
```

Organizer signing uses `~/.foundry/keystores/sepolia-deployer` and a separately prepared mode-0600 password file. Pass `--account` and `--password-file` for your existing signer configuration; the removed SP1 signer helper is not required. Never put passwords in command arguments or logs.

실제 Sepolia 실행 — 아래 명령은 deploy/register/open/submit transaction을 **전송**한다:

```sh
python3 scripts/sepolia_e2e.py \
  --cases 500,1500,3000 --reps 3 --confirmations 2 \
  --out artifacts/fpga-e2e-sepolia-RUN_ID
```

기본 chain ID는 11155111만 허용한다. Organizer와 keystore 주소가 같고 최소 0.1 Sepolia test ETH가 있는지 확인한다. 실제 비용은 receipt의 `gasUsed × effectiveGasPrice`로 기록한다. 이 잔액 검사값은 전체 비용의 고정 견적이나 상한이 아니다.

각 실행은 별도 contract 3개를 배포한다. 장치는 1회 등록, 채보는 크기당 1회 등록한다. `reps=3`이면 각 크기마다 새 session 3개를 발급한다. 3개 크기 실행의 전체 transaction 수는 `3 + 1 + 3 + 2×9 = 25`개다.

완료 뒤 이번 automation을 위해 만든 organizer password file은 삭제한다. 기존 encrypted keystore 및 테스트 장치 파일은 유지한다. 실패해도 pending transaction을 확인하기 전 같은 명령으로 재전송하지 않는다. 도구는 이미 `run.json`이 있는 출력 directory를 거부하며 자동 resume/replace transaction 기능은 제공하지 않는다.

### 로컬 smoke

```sh
anvil --port 8547 --block-time 1 --silent
```

별도 터미널에서:

```sh
python3 scripts/sepolia_e2e.py --local --rpc http://127.0.0.1:8547 \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --cases 4 --reps 1 --out artifacts/fpga-e2e-local-RUN_ID
```

`--local`은 chain 31337과 unlocked Anvil 계정을 사용한다. 이 결과를 Sepolia 실측으로 보고하지 않는다. 장치 raw-digest signature는 로컬 smoke에서도 기존 테스트 장치 keystore로 생성한다.

## 실제로 검증하는 순서

1. `GkrRelation`, `GkrScoreVerifier`, `ManiaGkrRegistry`를 배포한다. 배포 code 존재, verifier srsId와 organizer를 확인한다.
2. Chart registration proof를 실제 verifier가 검사한다. 저장된 commitment, notes, bits, components, maxEnd를 대조한다.
3. `openSession`의 성공 receipt에 있는 `SessionOpened`에서 ID를 얻고 확정 header를 다시 읽는다. Dry-run challenge를 사용하지 않는다.
4. 가상 입력 edge를 하나씩 수락하며 seq/held state/timestamp를 검사한다. 같은 event object에서 SHA chunk, KZG accumulator, 전체 trace를 만든다.
5. 종료 후 root와 C_E를 batch reference와 대조하고 V2 digest를 고정한다. 등록된 software device가 raw digest에 서명한다.
6. Prover adapter는 header/chart/rules/policy, event count/duration/root/C_E/digest/SRS를 대조한다. 원본 header를 덮어쓰거나 root를 reseal하지 않고 원본 C_E를 statement에 넣는다.
7. Native proof를 검증하고 서명을 복원한다. 제출 전 eth_call 및 estimateGas를 수행한다.
8. 실제 `submitCommitted` receipt status=1, 최소 2 confirmations, canonical block hash를 확인한다. `ScoreAccepted`, stored score/judgements, consumed=true를 대조한다.
9. 크기별 첫 run에서 root 변조, proof 변조, 성공 후 replay가 eth_call에서 revert하는지 검사한다. 단순 RPC 오류를 거부 성공으로 세지 않는다.

## 시간 측정 정의

| 기록 | 포함 / 제외 |
|---|---|
| `virtualPlaySeconds` | 합성 chart의 duration. 실시간 sleep하지 않으므로 wall latency에 포함하지 않음 |
| `deviceTimings.captureComputeMs` | 순차 edge 수락·KZG·SHA·최종 normalize/digest. SRS load와 batch cross-check 제외 |
| `streamKzgMs` | software에서 event별 G1 scalar multiply/add. FPGA 처리 시간 추정치가 아님 |
| `captureProcessSeconds` | capture executable startup, SRS load, 위 계산, cross-check, 파일 출력 포함 |
| `signProcessSeconds` | cast startup, encrypted device keystore unlock, signature 생성 포함 |
| `proverTimings.total_ms` | witness + GKR prover 단계. SRS load, chart registration 재계산, native verify 제외 |
| `proveProcessSeconds` | prover process startup, SRS load, adapter checks, chart 재계산, proof, native verify, 파일 출력 포함 |
| `captureStartToSubmissionReadySeconds` | capture 시작→서명→proof→calldata 준비. 음성/물리 replay 시간, 부정 시험, network submit 제외 |
| `submitPreflightSeconds` | 제출 직전 eth_call + estimateGas |
| `submitInclusionSeconds` | cast send 시작→성공 receipt 최초 관측. 지갑 unlock/broadcast/poll overhead 포함 |
| `submitConfirmationSeconds` | cast send 시작→2 confirmations 관측. Inclusion 시간을 포함 |
| `openStartToValidatedScoreSeconds` | 새 session 발급 시작→capture/sign/prove→submit→저장 점수 확인. 첫 반복의 부정 시험도 포함 |

각 반복은 새 process와 새 session이다. Protocol CPU 비용과 process/keystore/network overhead를 분리해 보고한다. Capture와 proving이 모두 software에서 실행되므로 FPGA timing이나 RTL의 cycle/Fmax/자원 수치로 해석하지 않는다.

실제 streaming 장치에서는 SHA·C_E 계산이 플레이 중 입력 수집과 겹칠 수 있다. 이 실험의 fast-forward capture 시간을 그대로 실제 게임 종료 후 대기 시간에 더하면 안 된다. STOP 후 drain 시간과 실제 하드웨어 처리량은 별도 측정 대상이다.

`confirmations=2`는 transaction이 포함된 블록과 그 뒤 1개 블록을 뜻한다. Consensus의 `finalized` 상태를 기다렸다는 뜻은 아니다. Block 포함 지연은 네트워크 상태와 제출 시점에 따라 달라지므로 작은 표본 3개의 median/min/max를 함께 보고한다.

## 완료 후 재검증 및 보고서

```sh
python3 scripts/test_e2e_adapter.py -v
python3 scripts/recheck_e2e.py artifacts/fpga-e2e-sepolia-RUN_ID \
  --out docs/benchmarks/sepolia-fpga-e2e-RUN_ID/chain-recheck.json
python3 scripts/report_e2e.py artifacts/fpga-e2e-sepolia-RUN_ID \
  docs/benchmarks/sepolia-fpga-e2e-RUN_ID
```

Adapter test는 4-note prepared fixture를 사용해 정직한 원본 입력 수락과 root/commitment/digest/SRS/count/duration/header 변조 거부, 잘못된 edge 상태/clock 거부를 검사한다. 벤치마크 CPU 측정과 겹치지 않게 별도로 실행한다. 재검증은 read-only RPC이며 새로운 transaction을 전송하지 않는다.
