# GKR 모드 B — 소프트웨어 FPGA → Sepolia E2E 실측

실행 구간(UTC): `2026-09-25T08:31:07Z` → `2026-09-25T08:43:05Z`. Chain ID 11155111.

**9/9회 점수 제출 성공**, 모든 세션에서 reference와 같은 **1,000,000점** 및 judgement counts를 확인했다. 전체 25개 transaction이 status=1이며 각 거래는 최소 2 confirmations를 관측했다.

FPGA 입력은 가상 시계의 DOWN/UP edge로 재생했다. 실제 SHA-256·BN254 commitment·secp256k1 서명·GKR/Zeromorph proof·Solidity 검증을 사용했다. **FPGA/SE050 실측은 아니며, known-tau 개발용 SRS를 사용한 기능·성능 시뮬레이션이다.**

## 주요 결과 — 각 크기 3회, 중앙값

| 노트 / 이벤트 | 순차 입력·SHA/KZG 계산 | GKR proving¹ | 입력 재생 시작→제출 준비² | 전송→최초 포함³ | 전송→2 confirmations³ | 제출 gas | proof bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| 500 / 1,000 | 0.481 s | 0.397 s | 1.091 s | 10.412 s | 23.211 s | 2,110,794 | 21,792 |
| 1,500 / 3,000 | 1.447 s | 0.959 s | 2.660 s | 7.697 s | 19.940 s | 2,302,505 | 25,728 |
| 3,000 / 6,000 | 2.848 s | 1.632 s | 4.768 s | 18.751 s | 32.349 s | 2,403,880 | 27,840 |

¹ Witness 포함. SRS load, 장치 C_E 생성, chart registration 재계산, native verify 제외.
² Capture/prover process startup, SRS load, 교차검사, encrypted device keystore 서명, 파일 출력·calldata 준비 포함. Virtual play의 wall-clock sleep, 제출 전 network preflight, 부정 시험 제외.
³ `cast send` 시작부터 관측한 wall time이므로 organizer keystore unlock, RPC 및 polling overhead 포함. 2 confirmations는 포함 블록 + 후속 1개 블록이며 consensus finalized를 뜻하지 않는다.

## 입력과 측정 조건

- 4 lanes, note 간격 150 ms, 4개 중 1개는 300 ms hold. 나머지는 tap. 모든 입력은 정확한 head/tail 시각의 perfect play.
- 매 반복에 새 on-chain session/challenge를 발급하고, 그 확정 header로 capture를 시작했다. 서명 후 header/root/C_E를 재바인딩하지 않았다.
- 가상 시계를 fast-forward했다. 아래 플레이 duration을 실제로 기다린 시간은 결과 latency에 포함하지 않았다.
- 실제 FPGA에서는 입력 수집과 SHA/KZG 계산이 플레이 중 겹칠 수 있다. 여기의 capture 비용은 실제 STOP 이후 대기 시간이나 FPGA 처리량의 예측치가 아니다.
- CPU: Apple M3 Max, 16 logical cores, RAM 48 GiB. 각 반복은 별도 executable process이며 software ECC 비용을 FPGA latency로 해석할 수 없다.
- SRS Smax=22, srsId=`0x5d94edcfeaf0d7af402a632e7bcd42e9f4be43dbdd891b9dd8f033cfbcd99d14`.
- SRS file SHA-256=`a5ac021a1cd1a0eaac8207be28dea1afeb6f7246dc6ed8bf481e5cd3c1cff980`.
- SRS와 verifier는 known-tau development setup이다. Bench gas/기능을 측정할 수 있지만 운영 proof soundness의 근거가 되지 않는다.

| 노트 | virtual play | 채점 components | trace payload | calldata bytes | proof words |
|---|---:|---:|---:|---:|---:|
| 500 | 75.986500 s | 625 | 14,000 B | 22,500 | 681 |
| 1,500 | 225.986500 s | 1,875 | 42,000 B | 26,436 | 804 |
| 3,000 | 450.986500 s | 3,750 | 84,000 B | 28,548 | 870 |

모드 B 제출 calldata에는 전체 trace가 없다. Trace는 sidecar가 witness를 만들기 위해 보관했다.

## CPU 세부 단계 — 중앙값 ms

| 노트 | witness | advice commit | GKR | row sumcheck | reduction | Zeromorph opening | native verify | device signing process |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 500 | 2.774 | 13.672 | 63.205 | 108.406 | 21.285 | 193.316 | 3.144 | 17.776 |
| 1500 | 9.461 | 50.009 | 97.346 | 163.303 | 45.303 | 599.864 | 3.545 | 17.864 |
| 3000 | 19.388 | 88.404 | 130.200 | 222.011 | 75.484 | 1087.622 | 3.492 | 18.137 |

각 단계의 중앙값을 더한 값은 전체 시간의 중앙값과 같지 않을 수 있다. 단계 사이 bookkeeping도 존재한다.

## 변동 범위 — min / median / max, seconds

| 노트 | proving | 제출 준비 | 최초 포함 | 2 confirmations |
|---|---|---|---|---|
| 500 | 0.396 / 0.397 / 0.404 | 1.087 / 1.091 / 1.097 | 10.011 / 10.412 / 21.161 | 20.599 / 23.211 / 34.602 |
| 1500 | 0.916 / 0.959 / 0.981 | 2.620 / 2.660 / 2.663 | 7.282 / 7.697 / 19.615 | 19.391 / 19.940 / 33.144 |
| 3000 | 1.605 / 1.632 / 1.673 | 4.739 / 4.768 / 4.775 | 18.303 / 18.751 / 29.991 | 28.113 / 32.349 / 42.299 |

표본은 크기별 3개다. 이 min/max를 network latency의 장기적인 보장으로 해석하지 않는다.

## 배포·등록 비용과 전체 비용

| 초기 작업 | gasUsed | 비용 (Sepolia test ETH) | 거래 |
|---|---:|---:|---|
| deploy-GkrRelation | 2,294,109 | 0.002529171 | [0x7f430c8e…](https://sepolia.etherscan.io/tx/0x7f430c8ebe11a891798d511c57d6c85848d098f175878a1923b2974dd157e971) |
| deploy-GkrScoreVerifier | 6,499,680 | 0.006588805 | [0x0211ae1d…](https://sepolia.etherscan.io/tx/0x0211ae1d991fd9bd3e92fe2e0775fbc997247f2ecaf741c6e088500995b290f7) |
| deploy-ManiaGkrRegistry | 2,181,251 | 0.002451521 | [0x119cf33f…](https://sepolia.etherscan.io/tx/0x119cf33f39cc32faf1b4e96d59f4ae68d595c46bad7a914c92c58b2b3b880193) |
| register-software-device | 67,238 | 0.000075094 | [0x170770c2…](https://sepolia.etherscan.io/tx/0x170770c24f13cfd3d4c9398b43423118a4e7e48ae5738e7792656415ed834f93) |
| register-chart-500 | 1,610,477 | 0.001618873 | [0xf65c7eb9…](https://sepolia.etherscan.io/tx/0xf65c7eb9f81699f73236b0e32bfb7118d39d75346ffcc5254d2644337c24d8f8) |
| register-chart-1500 | 3,967,528 | 0.004458181 | [0x1e14e9f0…](https://sepolia.etherscan.io/tx/0x1e14e9f02fb6f74adc15244c52e62b683c68772aa3afc228fcb5de9ec8ce2396) |
| register-chart-3000 | 7,489,917 | 0.008116125 | [0x60ebaf43…](https://sepolia.etherscan.io/tx/0x60ebaf4342473a18f5418dd5fcab8b0803fdc0cd29105ad273888911d61f1701) |

전체 25개 거래 실제 비용: **0.050725744 Sepolia test ETH**. 배포·장치/채보 등록·9개 세션 발급·9개 점수 제출을 포함한다. Mainnet 비용으로 환산하지 않았다.
채보 등록은 채보당 한 번, contract 배포는 배포당 한 번의 비용이다. 매 플레이 제출 비용과 분리해야 한다.

## 모든 점수 제출의 검증 근거

| 노트 | 반복 | block | score | gas | 2 confirmations (s) | transaction |
|---|---:|---:|---:|---:|---:|---|
| 500 | 1 | 11778047 | 1,000,000 | 2,110,794 | 20.599 | [0xa3d1b235…](https://sepolia.etherscan.io/tx/0xa3d1b2350e2359a240d19a21980d12a4b342b2e3c2cd59bf28255fe1f3af3a17) |
| 500 | 2 | 11778052 | 1,000,000 | 2,110,818 | 34.602 | [0x8eaf2498…](https://sepolia.etherscan.io/tx/0x8eaf2498c0655e1f4bb930490c45702eddbfc57ef98ee25e2b1ac4c079354ee7) |
| 500 | 3 | 11778056 | 1,000,000 | 2,110,602 | 23.211 | [0x4c85f181…](https://sepolia.etherscan.io/tx/0x4c85f1812a5d11df4fe2f2bd9a27fc0cfc93bc299a1eed7deaff3f1d43b61c5d) |
| 1500 | 1 | 11778062 | 1,000,000 | 2,302,505 | 19.940 | [0xacb0d3e8…](https://sepolia.etherscan.io/tx/0xacb0d3e8a073a34e12da9e770439779ad6b881df4eb457cae1fa541a39e9c9a3) |
| 1500 | 2 | 11778068 | 1,000,000 | 2,302,564 | 33.144 | [0x87d30d5b…](https://sepolia.etherscan.io/tx/0x87d30d5b332f2143d447f09aad8c4d45899d8512ef131cd1a6d1fb99f4522462) |
| 1500 | 3 | 11778072 | 1,000,000 | 2,302,373 | 19.391 | [0xf3632c7b…](https://sepolia.etherscan.io/tx/0xf3632c7b7d868c6fff070cc968ab65bdd7f7441c4f2cfa176fc15c6c7ee20273) |
| 3000 | 1 | 11778080 | 1,000,000 | 2,403,773 | 28.113 | [0x7152c117…](https://sepolia.etherscan.io/tx/0x7152c117e4e8cd0ee7d882aba52dd9f483842c853c1a806b3936905a2d9afa00) |
| 3000 | 2 | 11778086 | 1,000,000 | 2,403,880 | 42.299 | [0xc984255f…](https://sepolia.etherscan.io/tx/0xc984255f444cfb2da0c2d1b7482fcb9514dac8d9f232c7a7e375121952472e48) |
| 3000 | 3 | 11778092 | 1,000,000 | 2,404,013 | 32.349 | [0xb692ebd6…](https://sepolia.etherscan.io/tx/0xb692ebd6f4643e4f60cd8464992c8eb7e80221b121a794d6c9219bfb087575e2) |

검사한 항목: receipt status=1, canonical block hash, ScoreAccepted event, getSession의 score/judgements, consumed=true. 각 session ID와 원본 receipt는 [run.json](run.json)에 있다.

| 부정 시험 | 수행 수 | 결과 |
|---|---:|---|
| mutated-root | 3 | 전부 eth_call revert |
| mutated-proof | 3 | 전부 eth_call revert |
| replay | 3 | 전부 eth_call revert |

부정 시험은 실패 transaction을 실제 전송하지 않고 deployed contract의 eth_call로 확인했다. RPC 연결 실패는 거부 성공으로 계산하지 않았다.

## 배포 주소

- GkrRelation: [0xdbcf4f998de366ee0fa858caf7fa9006a415c396](https://sepolia.etherscan.io/address/0xdbcf4f998de366ee0fa858caf7fa9006a415c396)
- GkrScoreVerifier: [0xeb1b93855124918ddf710f244c2a3fa41f0d4963](https://sepolia.etherscan.io/address/0xeb1b93855124918ddf710f244c2a3fa41f0d4963)
- ManiaGkrRegistry: [0xd5e42d493efb44d69ca9185d33e41860b4f5254e](https://sepolia.etherscan.io/address/0xd5e42d493efb44d69ca9185d33e41860b4f5254e)

## 최종 재확인과 adapter 테스트

`2026-09-25T08:43:54Z`에 head block 11,778,096 기준으로 전체 25개 receipt의 canonical block hash와 성공 상태, 9개 세션의 consumed/score/judgements를 다시 확인했다. 모두 일치했다.
재조회 시 finalized block은 11,778,014이며 이 거래 중 finalized 상태인 것은 0개다. 이 보고서의 완료 기준은 2 confirmations이고 finalized 대기는 포함하지 않았다.
추가 adapter 통합 테스트 **11개 통과**: 정직 입력, sealed header/root/commitment/digest/SRS/count/duration 변조, initial UP/duplicate DOWN/감소 clock. [테스트 로그](adapter-tests.log)
이전 handoff의 source manifest와 비교해 기존 147개 파일은 변경되지 않았다. 이번에 simulator·orchestrator·검증/보고 도구·문서만 추가했다. 임시 organizer password file은 실행 종료 뒤 삭제했다. [실행 로그](execution.log)

## 재현과 원본

- [실행 절차](../../../SEPOLIA_E2E.md)
- [전체 run·receipt·환경·소스 hash](run.json)
- [최종 RPC 재확인](chain-recheck.json)
- `gkr-scoring/artifacts/fpga-e2e-sepolia-20260925/`: 각 run의 header/play/device result/signature/proof/submission 원본.
- CPU/chain 결과는 이 실제 실행의 관측값이다. 물리 edge 검출·debounce·USB·SE050·secure boot·FPGA 합성/타이밍은 이번 실험에 포함되지 않았다.
