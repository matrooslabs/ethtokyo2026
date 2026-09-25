# Sepolia 배포 및 점수 제출

모든 명령은 `sp1-scoring/`에서 실행합니다. Sepolia(chain ID **11155111**)만 허용하며,
공식 [Groth16 verifier gateway](https://docs.succinct.xyz/docs/sp1/verification/contract-addresses)
`0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`를 사용합니다. 배포된 verifier의
주소·코드, 로컬 guest의 program key, proof의 key를 확인합니다.

`sepolia.sh`는 기본적으로 RPC 상태에서 **시뮬레이션만** 합니다. `--broadcast`를
붙이면 선택한 지갑으로 서명하고 실제 Sepolia 트랜잭션을 전송합니다. Foundry의
시뮬레이션을 생략하는 옵션은 제공하지 않습니다. 실제 제출 시 gateway가 해당 proof의
verifier route를 지원하고 동결되지 않았는지도 검증 과정에서 확인됩니다.

## 1. 설정과 program key

Foundry, SP1 toolchain, 실행 중인 Docker(Groth16용), Sepolia ETH가 있는 지갑이 필요합니다.
키를 `.env`에 넣지 않고 Foundry encrypted keystore를 사용합니다.

```sh
cp .env.example .env
# .env의 SENDER_ADDRESS, FOUNDRY_ACCOUNT 등을 채웁니다.
# 아직 계정이 없다면 키를 터미널의 비공개 프롬프트로 가져옵니다:
cast wallet import sepolia-deployer --interactive
set -a
source .env
set +a

bash scripts/build_sp1.sh
mkdir -p artifacts
host/target/release/mania-sp1-host vkey artifacts/vkey.json
```

`vkey`는 입력·세션·proof 생성 없이 guest ELF에서 추출됩니다. 따라서 계약 배포 전에
얻을 수 있습니다. guest를 변경/재빌드해서 key가 바뀌면 기존 계약에 제출할 수 없고
새 key로 계약을 배포해야 합니다. `.env`의 파일 경로는 `contracts/` 기준입니다.

Ledger 등 다른 서명 방식은 동일한 Foundry script를 직접 실행해 사용할 수 있습니다.

## 2. 계약 배포

```sh
bash scripts/sepolia.sh deploy                 # 시뮬레이션
bash scripts/sepolia.sh deploy --broadcast     # 실제 Sepolia 전송

export MANIA_VERIFIER=$(python3 scripts/receipt_value.py deploy \
  contracts/broadcast/Sepolia.s.sol/11155111/run-latest.json)
echo "$MANIA_VERIFIER"
```

반드시 **성공한 전송 직후** 주소를 추출합니다. 이후 register/open 명령은 같은
`run-latest.json`을 갱신합니다. helper는 mined receipt의 성공 상태·block hash를 확인하며
dry-run 출력의 예상 주소를 배포 결과로 취급하지 않습니다. 배포자는 organizer가 됩니다.
주소를 `.env`의 `MANIA_VERIFIER`에도 저장하면 후속 터미널에서 이어갈 수 있습니다.

## 3. 장치 등록과 세션 생성

`.env`의 `DEVICE_SIGNER`, `BITSTREAM_HASH`, `PLAYER_ADDRESS`를 실제 값으로 설정합니다.
`DEVICE_SIGNER`는 controller의 secp256k1 공개키에 대응하는 Ethereum 주소입니다.
`BITSTREAM_HASH`는 승인한 FPGA 이미지의 해시입니다. organizer 지갑으로 실행합니다.

```sh
bash scripts/sepolia.sh register
bash scripts/sepolia.sh register --broadcast

# 예시 match ID. 실제 대회에서는 고정된 match ID를 사용합니다.
export MATCH_ID=$(cast keccak 'OSUMANIA_SEPOLIA_DEMO_V1')

# 만점 합성 fixture의 canonical chart hash
export CHART_HASH=$(python3 -c 'import json; p=json.load(open("fixtures/perfect.json")); print("0x"+bytes(p["header"]["chart_hash"]).hex())')
# 플레이 + proving + 제출에 충분한 기한을 설정합니다(예: 24시간).
export SESSION_EXPIRES_AT=$(python3 -c 'import time; print(int(time.time())+86400)')

bash scripts/sepolia.sh open
bash scripts/sepolia.sh open --broadcast
export SESSION_ID=$(python3 scripts/receipt_value.py session \
  contracts/broadcast/Sepolia.s.sol/11155111/run-latest.json \
  --contract "$MANIA_VERIFIER")

bash scripts/sepolia.sh export
```

마지막 명령은 확정된 세션을 RPC에서 조회해 `artifacts/sepolia-session.json`에 씁니다.
**open 시뮬레이션의 challenge로 proof를 만들면 안 됩니다.** challenge는 실제 트랜잭션이
포함된 블록에 따라 달라집니다. 세션 ID도 성공한 `SessionOpened` 로그에서 추출합니다.
알 수 없는 세션, 만료/소비된 세션, 다른 program key의 계약은 거부합니다.

실제 플레이에서는 이 header를 controller에 전달하고, controller에서 원본 trace/footer와
서명을 받아 `PlayInput` JSON을 구성합니다. helper가 export한 hex 문자열은 Rust 입력에서
byte array가 됩니다. 기록 후 header를 바꾸거나 trace를 다시 seal하면 장치 서명이 무효입니다.

## 4. 테스트용 만점 입력 또는 실제 하드웨어 입력

하드웨어 연결 전 로직을 시험할 때만 다음 합성 입력 경로를 사용합니다.

```sh
python3 scripts/session_input.py --synthetic \
  --input fixtures/perfect.json --session artifacts/sepolia-session.json \
  --out artifacts/sepolia-play.json

# 만점 확인: 1,000,000, PERFECT 5개, achieved=maximum=1600
cargo run --release --locked -p mania-scoring-cli -- artifacts/sepolia-play.json
```

`--synthetic`을 명시해야 하며, 세션의 chart/ruleset/input policy가 맞아야 합니다.
이 명령은 세션에 맞춰 합성 trace root를 다시 계산하므로 **실제 서명된 trace에는
사용하면 안 됩니다.** 합성 입력에는 실제 하드웨어의 출처 보장이 없습니다.

## 5. EVM용 proof와 장치 서명

```sh
host/target/release/mania-sp1-host groth16 \
  artifacts/sepolia-play.json artifacts/sepolia-proof

host/target/release/mania-sp1-host verify \
  artifacts/sepolia-play.json artifacts/sepolia-proof
```

`artifacts/sepolia-proof/proof.json`의 `mode`가 `groth16`이고 `proof`가 있어야 합니다.
`core` proof, `execute` 출력, 다른 guest key는 제출 스크립트가 거부합니다. 현재 host는
로컬 CPU proving만 사용하며 유료 prover network로 자동 전환하지 않습니다.

장치가 서명한 `sessionDigest`의 raw secp256k1 서명을 다음 파일로 준비합니다:

```json
{"signature":"0x<r 32bytes><low-s 32bytes><v 1byte: 1b 또는 1c>"}
```

저장 경로는 `artifacts/device-signature.json`입니다. Ethereum `personal_sign` prefix가
붙으면 검증에 실패합니다. DER 변환과 recovery ID 처리는 [SPEC.md](SPEC.md)를 참고하세요.

**소프트웨어 장치로 합성 데모만 시험할 때**는 별도의 테스트 keystore 주소를 device로
등록한 뒤 아래처럼 서명할 수 있습니다. 이것은 FPGA/SE050 보안 보장을 제공하지 않습니다.

```sh
export DIGEST=$(python3 -c 'import json; p=json.load(open("artifacts/sepolia-proof/proof.json")); print("0x"+bytes(p["result"]["session_digest"]).hex())')
cast wallet sign --no-hash --account sepolia-demo-device "$DIGEST" \
  > artifacts/device-signature.hex
python3 - <<'PY'
import json
from pathlib import Path
sig = Path("artifacts/device-signature.hex").read_text().strip()
assert sig.startswith("0x") and len(bytes.fromhex(sig[2:])) == 65
Path("artifacts/device-signature.json").write_text(json.dumps({"signature": sig}) + "\n")
PY
```

## 6. 점수 제출과 확인

```sh
bash scripts/sepolia.sh submit                 # 실제 계약·gateway에서 전체 검증 시뮬레이션
bash scripts/sepolia.sh submit --broadcast     # 실제 제출

export SUBMIT_BLOCK=$(python3 scripts/receipt_value.py block \
  contracts/broadcast/Sepolia.s.sol/11155111/run-latest.json)
cast logs --rpc-url "$SEPOLIA_RPC_URL" --address "$MANIA_VERIFIER" \
  --from-block "$SUBMIT_BLOCK" --to-block "$SUBMIT_BLOCK" \
  'ScoreAccepted(bytes32,address,uint32)' "$SESSION_ID"
```

`ScoreAccepted`의 점수가 `1000000`인지 확인합니다. 같은 세션의 두 번째 제출은 거부됩니다.
제출은 다른 relayer도 할 수 있고 점수 소유자는 사전에 등록한 player로 유지됩니다.
트랜잭션은 `https://sepolia.etherscan.io/tx/<transactionHash>`에서 확인할 수 있습니다.

## 검증 범위

- 네이티브에서 tap/hold/mixed 각각 1·4·32·500·1,500·3,000·10,000노트 만점 검사: 모두 정확히 100만점.
- 추가 입력으로 상한 초과 불가, GREAT로 하락, Solidity의 1,000,001점 거부 검사.
- 실제 SP1에서 만점 fixture의 core proof 생성·검증, 저장된 proof 재검증.
- Foundry에서 deploy/register/open/export/submit 전체 스크립트 실행 및 부정 입력 거부.
  이 테스트의 SP1 gateway는 명시적 mock이며 실제 Groth16 검증을 대신하지 않습니다.
- 2026-09-22 실제 Sepolia RPC에서 canonical gateway 코드 존재 확인 및 배포 시뮬레이션 성공.
  실제 트랜잭션은 전송하지 않았습니다.
- 배포 dry-run과 실제 broadcast는 다릅니다. 배포 지갑 설정·Sepolia ETH·실제 Groth16 proof가
  준비되어야 실제 점수 제출을 완료할 수 있습니다. 로컬 test gas를 EVM proof gas로 해석하지 않습니다.

### 2026-09-23 실제 제출 완료

4노트 만점 합성 입력과 소프트웨어 테스트 장치로 deploy/register/open/submit을 모두
실제 Sepolia에 전송했습니다. 인증 웹 서버가 확정된 세션의 Groth16 proof를 생성했고,
공식 gateway를 통해 검증한 뒤 **1,000,000점**이 저장됐습니다.

- [배포된 ManiaScoreVerifier](https://sepolia.etherscan.io/address/0xd5fbfbc09940e3a06e75668e7f7a7e9415bdb897)
- [성공한 점수 제출 트랜잭션](https://sepolia.etherscan.io/tx/0xddbb6ee6afb4342a061285d2b8bc6c9515cdb9f91ee1c1818e6a1494b8aadc97)
- 실제 제출 gasUsed: **303,951**. HTTP proving 요청부터 다운로드까지 **272.149초**.
- receipt, 이벤트, 저장 점수와 세션 소비 상태를 확인했고 중복 제출 거부도 확인했습니다.

실제 FPGA의 입력 출처를 검증한 데모는 아닙니다. 설정·성능·전체 거래 내역은
[DEMO_READINESS.md](DEMO_READINESS.md)에 기록했습니다.
