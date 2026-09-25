# 로컬 Groth16 / Sepolia 실행 점검 — 2026-09-23

4노트 합성 데모와 소프트웨어 테스트 장치로 **웹 서버의 Groth16 생성부터 실제
Sepolia 점수 제출까지 완료**했다. receipt와 이벤트뿐 아니라 온체인 저장값도 확인했다.

## 완료

- Apple M3 Max 16코어 / RAM 48GiB 확인.
- 사용자가 Docker 메모리 설정을 높인 후 Docker를 재시작했다.
  실제 VM 메모리 **33,599,827,968 bytes(약 31.29GiB)**, CPU 16개 확인.
- 공식 `v6.1.0-groth16.tar.gz` 다운로드 완료: 6,211,807,514 bytes.
- SHA256: `18beebb6cd0cc9b4d4a240ee4f49511da6c2a7e51724bad4232de538a9147810`.
  이 값은 내려받은 파일의 로컬 체크섬이며 별도의 공급자 서명 검증을 의미하지 않는다.
- `~/.sp1/circuits/groth16/v6.1.0/`에 회로·proving key·verification key 설치 완료.
  압축 해제된 자료는 약 8.4GB. host의 `groth16ArtifactsReady: true` 확인.
- 공식 이미지 `ghcr.io/succinctlabs/sp1-gnark:v6.1.0` 설치 및 CLI 실행 확인.
  이미지 digest: `sha256:e1a1cd62838b561ca301f9b2c26475c4a92bfe0e2c916e9bba213062e1548c4d`.
- 해당 이미지에는 ARM64 manifest가 없다. M3에서는 `linux/amd64` 에뮬레이션을 사용한다.
- 배포 dry-run 후 deploy/register/open/submit 네 트랜잭션 모두 Sepolia에서 성공.

## Groth16 실제 측정

입력은 `fixtures/perfect.json`: 4노트, tap/hold를 합쳐 PERFECT 5개인 합성 샘플이다.
실제 사람의 플레이 또는 FPGA trace가 아니다.

| 항목 | 결과 |
|---|---:|
| 점수 | 1,000,000 |
| proving + host 내부 검증 | 234,329ms |
| host 전체 wall time | 244.34초 |
| EVM proof bytes | 356 bytes |
| publicValues | 512 bytes |
| Docker 메모리 사용 관측값 | 약 18.52GiB (최대치 계측 아님) |
| 저장된 proof의 별도 host 검증 | 성공 |

공통 자료와 Docker 이미지를 미리 설치한 상태의 CPU proving 단일 측정이다.
M3에서 마지막 Docker 단계는 AMD64 에뮬레이션으로 실행했다.
4노트 결과를 큰 채보의 생성 시간으로 외삽하면 안 된다.

Sepolia 블록 **11764550**에서 공식 gateway에 실제 `eth_call`을 실행했다.

- 정상 proof: 성공.
- 동일 proof에 공개 점수만 1만큼 변조: revert.
- gateway 호출 gas estimate: **267,922 gas**. 전체 ManiaScoreVerifier 제출 비용이 아니다.
- 이 조회는 트랜잭션이 아니며 점수를 온체인 storage에 기록하지 않는다.

증거: `artifacts/groth16-perfect/proof.json`, `time.log`, `sepolia-gateway-check.json`.

## 실제 웹 서버 → Sepolia 제출

- 계약: [`0xd5fbfbc09940e3a06e75668e7f7a7e9415bdb897`](https://sepolia.etherscan.io/address/0xd5fbfbc09940e3a06e75668e7f7a7e9415bdb897)
- 세션: `0x5df246bf634aea2dcc18aac81f3b3dfe7bcf696660469bedaad4e6ead1c5d51e`
- 소프트웨어 장치: `0xAA485231c02401F6c3b74d9f7f025071E1d323c3`
- 점수 소유자: `0x969e3EB1FE56a525E6D87b1A39D3C0AeDe696d75`

확정된 세션 header에 합성 trace를 결합하고, 인증 HTTP 요청으로 proof를 생성했다.
다운로드한 proof를 별도 host 프로세스에서 재검증한 뒤 테스트 장치가 sessionDigest에
서명했다. 기존 샘플 proof를 새 세션에 재사용하지 않았다.

| 항목 | 실제 측정 |
|---|---:|
| HTTP 제출 → proof 다운로드 | **272.149초 (약 4분 32초)** |
| host의 proving + 내부 검증 | 259,899ms |
| 온체인 저장 점수 | **1,000,000** |
| 제출 트랜잭션 gasUsed | **303,951 gas** |
| 네 트랜잭션 총 수수료 | 0.002328059713404429 Sepolia ETH |

| 단계 | 트랜잭션 | 실제 gasUsed |
|---|---|---:|
| 배포 | [79a29d98…](https://sepolia.etherscan.io/tx/0x79a29d98bf02b4b30707c1d1a1254768c17e4586df6ed3d887357e07910255bb) | 1,288,374 |
| 장치 등록 | [f029b7d6…](https://sepolia.etherscan.io/tx/0xf029b7d69a64012bc38f2d2cdafb434876479ff0e9ed6f613f9040ccb1dc0dc9) | 67,097 |
| 세션 생성 | [97191a55…](https://sepolia.etherscan.io/tx/0x97191a55f3c9994f05b2ad523231a85edfc5148680a63538941de2fb59123406) | 297,911 |
| 점수 제출 | [ddbb6ee6…](https://sepolia.etherscan.io/tx/0xddbb6ee6afb4342a061285d2b8bc6c9515cdb9f91ee1c1818e6a1494b8aadc97) | 303,951 |

블록 **11764605**에서 제출 receipt status=1, `ScoreAccepted`의 세션·플레이어·100만점,
`getSession`의 consumed=true 및 score=1000000을 모두 확인했다.
같은 제출을 `eth_call`로 반복하면 `unknown or consumed session`으로 거부된다.

실제 HTTP Groth16 smoke test도 별도로 성공했다. 위 시간은 한 세션의 측정값이며
성능 보장이 아니다. 작은 샘플도 약 4분 32초이므로 즉시 결과를 보여주는 데모에는
로컬 CPU 지연이 크다. 실제 긴 채보·FPGA 플레이의 성능이나 입력 출처는 검증하지 않았다.

증거와 실행 로그는 `artifacts/sepolia-confirmed/result.json`, `http-benchmark.json`,
각 단계의 receipt JSON, `artifacts/sepolia-proof/`에 있다. `.env`에는 배포 주소와
소비된 세션이 저장돼 있으므로 다시 시연할 때는 새 세션을 열고 proof를 다시 생성해야 한다.

사용자 지갑의 임시 `artifacts/private-signing/deployer.password`는 전송 완료 후 삭제했다.
다시 잠금 해제가 필요하면 로컬 터미널에서 `python3 scripts/unlock_demo_signer.py`를 실행한다.
비밀번호는 숨김 프롬프트로 입력하며 mode 0600 파일에 임시 저장된다. 후속 Foundry 명령의
`ETH_PASSWORD`에는 파일의 절대 경로를 설정한다. 작업 완료/취소 시 파일을 삭제한다.
테스트 장치의 별도 keystore는 ignored `artifacts/private-signing/`에 보관한다.

## 메모리 확대 후 샘플 측정

`sp1-scoring/`에서 실행한다. 아래 입력은 합성 샘플이며 실제 세션에 제출할 입력이 아니다.

```sh
mkdir -p artifacts/groth16-demo
DOCKER_DEFAULT_PLATFORM=linux/amd64 /usr/bin/time -l \
  host/target/release/mania-sp1-host groth16 \
  fixtures/demo.json artifacts/groth16-demo \
  > artifacts/groth16-demo/run.log 2> artifacts/groth16-demo/time.log

DOCKER_DEFAULT_PLATFORM=linux/amd64 \
  host/target/release/mania-sp1-host verify \
  fixtures/demo.json artifacts/groth16-demo
```

`proof.json`의 `provingMillis`는 proving과 host 내 로컬 검증을 합친 시간이다.
`time.log`의 wall time은 host 시작·준비 작업까지 포함한다. macOS 프로세스의
최대 메모리 값은 Docker VM의 메모리 사용량을 포함하지 않는다.

실제 제출용 proof는 [SEPOLIA.md](SEPOLIA.md)의 순서대로 **확정된 온체인 세션**에
결합된 입력으로 생성해야 한다. 이 샘플 proof를 새 세션에 그대로 재사용할 수 없다.

설치 증거와 배포 시뮬레이션 로그는 gitignore된 `artifacts/groth16-setup/`에 있다.
다운로드 archive는 재사용을 위해 유지했고, 중복된 분할 다운로드 파일은 제거했다.
