# SP1 proving HTTP server

FPGA/sidecar가 만든 `PlayInput`을 받아 실제 SP1 proof를 생성하는 Rust/Axum 서버입니다.
기존 `mania-sp1-host`를 별도 프로세스로 실행합니다. 요청 안에서 proving이 끝날 때까지
기다리는 대신 job ID를 즉시 반환하고, 상태 조회와 결과 다운로드를 제공합니다.

```
FPGA → sidecar: header + 전체 trace + footer + 장치 서명
sidecar → POST /v1/proofs: { mode, input: PlayInput }
server: native 검증 → 대기 큐 → SP1 proving → 저장된 proof 재검증
sidecar ← job 상태 / proof.json / proof.bin
sidecar → Sepolia: Groth16 proof + publicValues + 원래 장치 서명
```

서버는 입력의 hash/sequence/상태 전이/채점 결과를 검증하지만 **장치 서명을 검증하거나
생성하지 않습니다.** 서버에 보낸 입력으로 점수가 올바르게 계산되었다는 proof를 제공합니다.
실제 장치 출처와 열린 세션의 일치는 기존 Solidity 계약에서 검증합니다. 지갑 키, 장치
private key, `deviceSignature`를 API에 전달할 필요가 없습니다. 트랜잭션도 자동 전송하지 않습니다.

sidecar는 FPGA의 모든 chunk와 최종 footer를 받은 뒤 전체 `PlayInput`을 한 요청으로
전달합니다. 부분 trace의 streaming 업로드는 지원하지 않습니다. JSON의 hash/address는
기존 fixture와 같은 정수 byte array이며 hex 문자열이나 base64가 아닙니다. USB wire
encoding과 JSON 변환을 구분하고, 원래 header·event·footer 값을 그대로 유지해야 합니다.

## 실행

아래 명령은 `sp1-scoring/` 기준입니다.

```sh
# SP1 host/guest를 먼저 빌드합니다. SP1 설치와 protoc가 필요합니다.
bash scripts/build_sp1.sh
cargo build --release --locked -p mania-proof-server

# 로컬 개발: 127.0.0.1:8080, core proving
target/release/mania-proof-server
```

서버 시작 시 host에서 program key를 추출합니다. 실행 파일이 없거나 key 추출이 실패하면
시작하지 않습니다. 기본 경로는 `host/target/release/mania-sp1-host`이며 `--host-bin`으로
다른 빌드 경로를 지정할 수 있습니다. API 요청으로 실행 파일이나 명령을 지정할 수 없습니다.

다른 기기에서 접속하게 하려면 인증 토큰을 설정합니다.

```sh
export PROVER_API_TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
target/release/mania-proof-server --bind 0.0.0.0:8080
```

토큰은 최소 32바이트이며 `Authorization: Bearer <token>`으로 전달합니다. non-loopback
바인딩은 토큰 없이 시작할 수 없습니다. 외부 배포 시 HTTPS reverse proxy 뒤에서 실행합니다.
현재 인증은 **공유 토큰을 사용하는 단일 서비스**이며, 사용자별 계정·job 소유권 분리는 없습니다.
같은 토큰을 가진 클라이언트는 알고 있는 job ID의 상태/결과 조회와 완료 job 삭제가 가능합니다.

Groth16은 Docker가 실행 중이고 공통 circuit artifact 준비가 완료된 환경에서 활성화합니다.

```sh
target/release/mania-proof-server --enable-groth16 --timeout-seconds 1800
```

기본 모드는 core만 허용합니다. Core proof는 EVM에 제출할 수 없습니다. Groth16의 공통
circuit artifact가 준비되지 않았으면 서버 시작을 거부합니다. 이를 확인하는 최신 host를
빌드하고, 서버 시작 전에 시간 제한이 없는 기존 CLI로 cache와 gnark image를 준비합니다:

```sh
host/target/release/mania-sp1-host groth16 fixtures/perfect.json artifacts/groth16-warmup
```

초기 circuit archive 다운로드만 약 6.2GB(SP1 circuit v6.1.0)이며 압축 해제 공간도
필요합니다. 준비 여부는 host의 `vkey` 출력에 있는 `groth16ArtifactsReady`로 확인합니다.
유료 prover network나 mock prover로 자동 전환하지 않습니다.

## 클라이언트 예제

별도 터미널에서 같은 토큰을 설정한 뒤:

```sh
python3 scripts/prove_http.py fixtures/perfect.json \
  --server http://127.0.0.1:8080 --mode core --out artifacts/http-perfect

# 다운로드한 바이너리를 클라이언트 측 host에서 독립적으로 재검증
host/target/release/mania-sp1-host verify fixtures/perfect.json artifacts/http-perfect
```

`prove_http.py`는 생성 → polling → 다운로드를 수행합니다. `job.json`, `proof.json`,
`proof.bin`을 출력 폴더에 저장하며 기존 proof 폴더를 덮어쓰지 않습니다. 클라이언트의 대기
시간 초과는 서버 작업을 취소하지 않으므로 저장된 job ID로 상태 조회를 계속할 수 있습니다.

Sepolia 세션에 연결된 실제 입력을 준비한 경우:

```sh
python3 scripts/prove_http.py artifacts/sepolia-play.json \
  --mode groth16 --out artifacts/sepolia-proof
```

서버가 반환하는 `proof.json`은 기존 `SubmitScoreSepolia` 스크립트와 같은 형식입니다.
장치 서명 파일을 별도로 준비한 다음 기존 [Sepolia 제출 절차](../SEPOLIA.md)를 사용합니다.
`fixtures/perfect.json`은 합성 샘플이며 실제 Sepolia 세션에 그대로 제출할 수 없습니다.

## API

`/healthz`를 제외한 모든 경로에 토큰 인증이 적용됩니다(토큰을 설정한 경우).

| 메서드 / 경로 | 응답 |
|---|---|
| `GET /healthz` | HTTP listener liveness, `{"status":"ok"}` |
| `GET /v1/meta` | 현재 program vkey, 지원 proof mode, 요청 크기, worker 수 |
| `POST /v1/proofs` | `202 Accepted`, job JSON, `Location` 상태 조회 URL |
| `GET /v1/proofs/{id}` | 상태·시간·vkey·성공 시 score·실패 시 error |
| `GET /v1/proofs/{id}/proof.json` | 성공한 job의 proof fixture |
| `GET /v1/proofs/{id}/proof.bin` | 성공한 job의 SP1 binary proof; streaming download |
| `DELETE /v1/proofs/{id}` | 완료/실패 job의 입력·proof·로그 삭제, `204` |

생성 요청은 기존 fixture를 `input`으로 감쌉니다. 허용 mode는 `core`, `groth16`입니다.

```sh
python3 - <<'PY'
import json
from pathlib import Path
Path("artifacts/request.json").write_text(json.dumps({
    "mode": "core",
    "input": json.loads(Path("fixtures/perfect.json").read_text())
}))
PY
curl --fail-with-body http://127.0.0.1:8080/v1/proofs \
  -H "Authorization: Bearer $PROVER_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @artifacts/request.json
```

응답 예시:

```json
{
  "id": "9bb0a7e1-251a-4109-ad98-94f824f1b6fe",
  "mode": "core",
  "status": "queued",
  "created_at_ms": 1790121600000,
  "updated_at_ms": 1790121600000,
  "vkey": "0x...",
  "score": null,
  "error": null
}
```

상태는 `queued → running → succeeded | failed`입니다. 백분율 진행률은 제공하지 않습니다.
성공으로 바꾸기 전에 host의 proof 생성·검증 성공, 저장된 `proof.bin` 재검증,
vkey/mode/publicValues/점수의 원본 입력과 일치를 확인합니다. 실패한 job의 부분 proof는
다운로드할 수 없습니다. Core 결과의 JSON `proof`는 `null`이며 `proof.bin`을 사용합니다.

주요 오류:

- `401`: 인증 누락/오류.
- `413`: 요청이 16 MiB 초과.
- `400/422`: 잘못된 JSON 구문·필드·mode 또는 잘못된 채보/trace/commitment.
- `429`: 대기 큐 또는 동시 HTTP 요청 한도 초과. 나중에 재시도합니다.
- `503`: Groth16 미활성화 또는 종료 중.
- `507`: 보관 job 수 한도 초과. 완료 job을 삭제합니다.
- `404`: 알 수 없는 job/파일.
- `409`: 완료 전 artifact 다운로드 또는 실행 중인 job 삭제 시도.

작업 중 prover 오류는 job의 `failed` 상태와 `error`로 반환됩니다. 큐 등록 이후 HTTP
연결이 끊겨도 작업은 계속됩니다. 네트워크 오류 후 POST 재시도는 새 job을 만들 수 있습니다.
자동 retry나 요청 중복 제거는 하지 않습니다.

## 실행 제한과 저장

| 옵션 | 기본값 | 의미 |
|---|---:|---|
| `--bind` | `127.0.0.1:8080` | 수신 주소 |
| `--queue-size` | `8` | 대기 가능한 job 수; 실행 중 1개 별도 |
| `--max-jobs` | `64` | 완료/실패 포함 보관 job 수 |
| `--timeout-seconds` | `1800` | proving + 저장된 proof 재검증 시간 제한 |
| `--data-dir` | `artifacts/server` | 이 서버만 사용하는 job 저장 디렉터리 |
| `--enable-groth16` | off | Docker 기반 EVM proof 활성화 |

proving worker는 하나로 고정했고, HTTP handler는 최대 16개로 제한합니다. 입력 검증은
백그라운드 thread에서 수행합니다. 채보/입력 한도는 기존 ruleset의 10,000노트·50,000이벤트·
30분입니다. job별 stdout/stderr는 각각 64 KiB까지만 보관하고 나머지도 계속 읽어 pipe가
막히지 않게 합니다. 반환 가능한 binary proof는 최대 512 MiB입니다. 이 크기 검사는
완성된 artifact에 적용되며 OS 메모리/디스크 quota를 대신하지 않습니다.

각 UUID 디렉터리에 입력, job metadata, proof와 로그를 저장합니다. 입력과 로그는 API로
노출하지 않습니다. Unix에서는 data directory 권한을 0700으로 설정합니다. 삭제하기 전까지
원본 입력이 디스크에 남으며 prover 운영자는 입력 내용을 볼 수 있습니다.

같은 data directory의 중복 서버 실행은 OS file lock으로 막습니다. 재시작 시 완료 job은
보존하고 중단된 queued/running job은 failed로 표시합니다. 자동 proving 재개는 하지 않습니다.
서버의 guest vkey가 바뀌면 기존 폴더로 시작하지 않고 새 `--data-dir`를 요구합니다.

SIGINT/SIGTERM 또는 시간 초과 시 prover 프로세스 그룹을 종료합니다. Groth16의 Docker
실행에는 job label을 붙이고 해당 label의 컨테이너만 정리합니다. 정리에 실패하면 다른
proving을 시작하지 않고 서버를 종료합니다. `SIGKILL`·전원 종료는 정리 코드를 실행할 수
없으므로, 운영 배포에서는 process supervisor의 프로세스 그룹 정리와 자원 제한을 사용하고
재기동 전 남은 prover/container를 확인해야 합니다.

## 테스트

```sh
cargo test --locked -p mania-proof-server

# mock 없는 실제 HTTP → SP1 core proof → 다운로드 → 별도 재검증
python3 scripts/smoke_http.py

# Docker와 충분한 proving 리소스가 있는 경우
python3 scripts/smoke_http.py --mode groth16 --timeout-seconds 1800
```

Rust API 테스트는 명시적인 test backend로 인증, 입력 거부, 큐/보관 제한, worker 수,
실패/변조 결과 차단, 복구/파일 lock, process timeout, Docker label 정리를 검사합니다.
`smoke_http.py`는 실제 host 바이너리로 proving하며 fixture의 점수가 정확히 100만점인지와
다운로드한 proof의 암호학적 검증까지 확인합니다.

2026-09-23 검증: 서버 테스트 8개, 기존 Rust scorer 테스트 15개 통과 및 Clippy 경고 0개.
실제 인증 HTTP 요청으로 core proof를 생성하고, 정확히 1,000,000점인 결과와 다운로드한
proof.bin의 별도 SP1 검증 성공을 확인했습니다.
최초 Groth16 HTTP 테스트는 circuit archive 다운로드 중 600초 제한으로 실패했습니다.
이후 공통 자료 설치와 Docker 메모리 확대(약 31.29GiB)를 완료한 뒤,
**실제 인증 HTTP Groth16 생성 → 100만점 결과 다운로드 → 별도 host 검증까지 통과**했습니다.
서버는 artifact가 미리 준비되지 않은 상태의 Groth16 활성화를 시작 단계에서 거부합니다.

현재 `sp1-gnark:v6.1.0` 공식 Docker 이미지에는 ARM64 manifest가 없습니다. Apple Silicon에서는
이미지를 `docker pull --platform linux/amd64 ghcr.io/succinctlabs/sp1-gnark:v6.1.0`으로 준비하고,
서버 시작 시 `DOCKER_DEFAULT_PLATFORM=linux/amd64`를 설정합니다. 마지막 wrapping은
AMD64 에뮬레이션으로 실행됩니다. 측정 결과는 [DEMO_READINESS.md](../DEMO_READINESS.md)를 참고하세요.
