# GKR (Sui) prove server

PlayInput을 JSON으로 보내면 BLS12-381 GKR/sumcheck proof(Sui Move verifier용)를 JSON으로 돌려주는
**단일 binary** HTTP 서버입니다.

## 빌드와 실행

`scoring/gkr-scoring-sui/` 기준 (Rust workspace: `scoring/Cargo.toml`).

```sh
cargo build --release --locked -p mania-gkr-sui -p mania-gkr-sui-prove-server
../target/release/mania-gkr-sui srs --smax 24 --out artifacts/dev-srs-24.bin   # INSECURE 개발용 SRS
../target/release/mania-gkr-sui-prove-server                                    # 127.0.0.1:8092
```

| 옵션 | 기본값 |
|---|---|
| `--bind` | `127.0.0.1:8092` |
| `--srs` | `artifacts/dev-srs-24.bin` |

개발용 SRS는 τ가 알려져 있어 proof를 위조할 수 있습니다. 운영에는 공개 BLS12-381 powers-of-tau로 만든 SRS가
필요합니다([README](../../gkr-scoring-sui/README.md)). SRS의 `smax`보다 큰 채보는 `500`으로 실패합니다.

## API

| 요청 | 응답 |
|---|---|
| `GET /healthz` | `{"status":"ok"}` |
| `GET /v1/info` | proof system, 검증 키 ID, 사용 가능한 mode |
| `POST /v1/prove` `{"mode": …, "input": PlayInput}` | **proof JSON** (아래) |

`input`은 `scoring/fixtures/*.json`과 같은 `PlayInput`입니다. 요청은 proof가 끝날 때까지 기다렸다가
결과를 같은 응답으로 돌려받습니다(job ID나 polling 없음).

```sh
python3 -c "import json;print(json.dumps({'mode':'committed','input':json.load(open('../fixtures/perfect.json'))}))" > /tmp/request.json
curl -s -X POST http://127.0.0.1:8092/v1/prove -H 'Content-Type: application/json' \
  --data-binary @/tmp/request.json > proof.json
```

오류는 `{"error": "..."}`입니다.

| 코드 | 의미 |
|---|---|
| 401 | `PROVER_API_TOKEN`을 설정한 서버에 token 없음/불일치 |
| 400/413/415/422 | 잘못된 JSON·필드, 16 MiB 초과, 지원하지 않는 mode, 채점 검증에 실패한 입력 |
| 503 | 다른 proof 실행 중. 잠시 후 재시도 |
| 500 | proving 실패 |

## 동작

- **하나의 binary.** proving 키/SRS를 시작할 때 한 번 메모리에 올리고, 요청마다 같은 프로세스 안에서 proof를 만듭니다.
- **입력 검증.** proving 전에 native 채점(`core::evaluate`)으로 입력을 검증합니다.
- **자체 검증.** 반환 전에 proof를 검증하고, 결과가 native 채점 결과와 같은지 확인합니다.
- **한 번에 proof 하나.** 요청한 client가 연결을 끊어도 시작된 proof는 끝까지 실행되고, 그동안 새 요청은 `503`을 받습니다.
- **종료.** SIGINT/SIGTERM을 받으면 실행 중인 proof를 기다리지 않고 종료합니다.
- **보안.** 기본은 `127.0.0.1`에만 바인딩합니다. 다른 기기에서 접속하려면 `PROVER_API_TOKEN`(32바이트 이상)을
  설정해야 하며, 그러면 `/healthz`를 제외한 요청에 `Authorization: Bearer <token>`이 필요합니다.
  외부 공개 시에는 HTTPS reverse proxy 뒤에서 실행하세요.
- **범위 밖.** CORS, 작업 큐, 결과 보관은 하지 않습니다.
- **코드 구성.** HTTP 계층 `src/http.rs`는 `prove-server-evm`, `prove-server-sui`에서 같은 파일이고,
  `src/prover.rs`만 proof system별로 다릅니다.

mode: `calldata`(모드 A), `committed`(모드 B).

## 응답

`mania-gkr-sui prove` 출력과 같은 필드에 `srsId`를 더한 JSON입니다.

| 필드 | 내용 |
|---|---|
| `mode`, `srsId` | `Calldata`/`Committed`, SRS 검증 키 ID |
| `result` | `score`, `achieved_points`, `maximum_points`, `judgements` |
| `laneBits`, `counts`, `proof` | proof 공개값과 proof bytes (hex) |
| `chartCommitment`, `traceCommitment`, `sessionDigest` | 채보·trace commitment(모드 B, 압축 G1), 서명 대상 digest |
| `timings` | 단계별 proving 시간 (ms) |

온체인 세션에 맞춘 제출 데이터(header 재바인딩, event chunk, 장치 서명)는 기존 `mania-gkr-sui prove-session`이 만듭니다.

## 테스트와 검증 상태

```sh
cargo test --release --locked -p mania-gkr-sui-prove-server
```

- HTTP 계층 테스트 2개와 실제 proving 테스트 1개가 통과했습니다. proving 테스트는 개발용 SRS로 `demo.json`을 두 mode로 증명하고, 점수·판정이 native 결과와 같은지 확인합니다.
- 2026-09-26 실제 binary로 `curl` 요청을 보내 확인했습니다: `perfect.json`, `calldata` → HTTP 200, 약 0.12초, 1,000,000점, proof 12,416 bytes.
