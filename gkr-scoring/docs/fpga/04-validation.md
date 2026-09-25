# 검증 자료와 인수 기준

## 1. 전달받은 폴더만으로 실행

Python 3.8 이상, 표준 라이브러리만 필요하다. `docs/fpga` 폴더 안에서:

```sh
python3 tools/check_vectors.py vectors
```

GKR 저장소 root에서는:

```sh
python3 docs/fpga/tools/check_vectors.py docs/fpga/vectors
```

정상 결과의 마지막 줄:

```text
PASS 10 device vectors; all chunk hashes, event-prefix commitments, V1/V2 digests; 3 group cases
```

검사기는 `assert`로 불일치를 중단한다. **`python -O`로 실행하지 않는다.** 이 도구는 개발용 oracle이며 상수 시간 암호 라이브러리나 untrusted input용 서비스가 아니다.

## 2. 벡터의 의미

[device-vectors.json](vectors/device-vectors.json)은 Rust 엔진으로 생성했다. 각 case는 다음을 제공한다.

- 입력 event list와 정확한 14-byte 직렬화.
- V2 header 구조와 292-byte packed header.
- SHA seed preimage/H0, chunk별 index/count/preimage/root.
- **각 이벤트 처리 직후**의 canonical affine C_E와 최종 C_E.
- V1 및 V2 session preimage와 최종 SHA-256 digest.

| 사례 | 겨냥하는 경계 |
|---|---|
| `boundary-0` | 이벤트 없음, root=H0, C_E=identity, 빈 chunk 없음 |
| `boundary-1` | t=0/lane=0/DOWN: 이벤트가 있어도 C_E=identity 가능 |
| `boundary-2` | 첫 nonzero lane 항과 global row indexing |
| `boundary-31/32/33` | 첫 chunk 전·정확한 경계·새 chunk 첫 이벤트 |
| `boundary-63/64/65` | 두 번째 경계, KZG index가 chunk마다 초기화되지 않음 |
| `timestamp-max` | t=1,800,000,000, lane=3, act=DOWN; 31-bit 시간과 2-bit lane |
| 별도 group 3개 | identity+G, G+(-G), G+G |

기본 event pattern은 `t=floor(j/8)*1000`, `lane=j%4`, `action=floor(j/4)%2`다. 네 lane의 DOWN/UP 순환으로 같은 시각의 여러 edge와 두 action을 모두 포함한다. 종료 시 held lane이 남아 있는 사례도 정상이며 UP을 합성하지 않는다.

**이 벡터는 encoding/commitment 시험용이다.** Header는 등록되지 않은 합성 값이고 chart와 signature는 포함하지 않는다. 실제 플레이 증명, signer recovery, SRS ceremony 검증을 통과한 자료라고 해석하면 안 된다. 기본 ROM은 seed가 공개된 insecure dev SRS다.

Python oracle는 별도로 구현한 affine BN254 덧셈/배가/정수 scalar multiplication으로 모든 prefix C_E를 계산한다. Rust 쪽 생성기 역시 순차 누적값과 엔진의 dense MSM 결과를 비교한다. Python은 ROM의 SHA-256, canonical/on-curve 좌표, 첫 generator와 그 order를 검사하지만 **G2 pairing 또는 모든 SRS power의 신뢰성을 검사하지 않는다.** `srsId`는 두 manifest 간 문자열 일치만 검사한다.

## 3. 재생성 및 운영 ROM export

GKR root에서 실행한다. Rust workspace는 현재 sibling `sp1-scoring/core`에 의존한다.

```sh
cargo run --release --locked --example fpga_vectors -- --out docs/fpga/vectors
```

승인된 기존 SRS로 별도 directory에 생성하는 예:

```sh
cargo run --release --locked --example fpga_vectors -- \
  --srs /absolute/path/to/approved-srs.bin \
  --points 262144 --out /absolute/path/to/export-directory
```

이 exporter는 `MGKRSRS1` 파일을 읽고 canonical G1 좌표를 내보내는 도구다. 파일의 ceremony provenance나 모든 power의 올바름을 인증하지 않는다. 잘못된 파일에 `approved`라는 이름을 붙여도 신뢰성이 생기지 않는다. 기본 출력의 260 points는 최대 65-event 벡터용이며 50,000-event 장치에 충분하지 않다.

## 4. 이번 실행 결과

기준일 2026-09-25, macOS 로컬 개발 환경. Rust/cargo 1.94.1, Foundry forge 1.5.1-stable, Python 3.9.6. 명령은 각 표에 적힌 cwd에서 실행했다.

| cwd / 실제 명령 | 결과 | 근거 |
|---|---|---|
| `gkr-scoring`: `cargo test --release` | 17 unit + 9 integration, failure 0 | [gkr-rust.log](validation/gkr-rust.log) |
| `gkr-scoring/contracts`: `forge test -vv` | 11 tests, failure 0 | [gkr-foundry.log](validation/gkr-foundry.log) |
| `sp1-scoring`: `cargo test --locked` | core integration 15 + server 8, failure 0 | [sp1-reference.log](validation/sp1-reference.log) |
| `gkr-scoring`: Rust 벡터 생성 명령 | 10 cases, 260 G1 points | [vector-generation.log](validation/vector-generation.log) |
| `gkr-scoring`: Python oracle 명령 | 10 cases 및 group cases 일치 | [vector-oracle.log](validation/vector-oracle.log) |

GKR의 `loads_public_ptau_when_available`는 `MGKR_PTAU`가 설정되지 않아 내부에서 조기 반환했다. Test runner가 이 case를 `ok`로 표시해도 **이번 실행에서 공개 ceremony 파일을 읽고 검증한 것은 아니다.** Foundry는 로컬 dev SRS와 Rust FFI helper로 시험했다. Test 통과는 운영 SRS의 신뢰성이나 실장치 안전성을 보증하지 않는다.

SP1 검증은 공통 V1 채점/입력 의미와 server 코드를 이해하기 위한 참고다. SP1 guest proof 생성, 네트워크 배포, 실제 보드/RTL 시뮬레이션, SE050 signing 시험은 실행하지 않았다. 기존 baseline 문서의 CPU benchmark를 이번 FPGA 성능 측정으로 사용하지 않는다.

## 5. FPGA 인수 시험표

아래 항목 중 제공 벡터와 기존 software tests 범위 밖의 항목은 **아직 실행하지 않은 통합 인수 조건**이다.

| 영역 | 필수 시험 | 합격 조건 |
|---|---|---|
| Byte encoder | 모든 제공 event와 header | byte-for-byte 일치, BE/address 폭 정확 |
| SHA | 0/1/31/32/33/63/64/65-event | 각 chunk preimage/root 및 V2 digest 일치 |
| SHA 최대 입력 | 50,000 events | 1,563 chunks, 마지막 16개, seq 49,999까지 일치 |
| KZG 기본 | 제공 prefix 전체 | 모든 이벤트 직후 affine C_E 일치 |
| KZG exceptional | identity, P+(-P), P+P, zero scalar | 결과와 identity encoding 일치; inversion-by-zero 없음 |
| KZG 범위 | lane 0..3/action 0..1/max timestamp/마지막 j=49,999 | 잘못된 scalar truncation 없음; 마지막 사용 power 199,998 |
| ROM | wrong checksum/endianness/curve/SRS bank | ARM 거부 또는 오류 latch; 정상 signature 없음 |
| 입력 유효성 | 감소 시간, t>D, lane=4, action=2, seq gap/중복, unmatched UP, duplicate DOWN | 정상 세션으로 서명하지 않음 |
| 종료 | 키를 누른 채 종료, 마지막 partial chunk, STOP과 edge 동시 발생 | 수락 경계 결정적; 자동 UP/빈 chunk 없음 |
| 용량 | 50,000/50,001 events, consumer stall, FIFO full | 한계 내 무누락; 한계 초과는 abort, truncate 없음 |
| 전송 | packet 중복/순서 변경/분실/재시도 | 원본 seq 기반 재조립, trace 변조/불완결 검출 |
| 전원·시계 | reset/brownout/clock fault | 불완전 상태에서 signature 발행 금지 |
| Signature | 실제 장치 digest, low-s, recovery parity | registry 등록 주소로 recovery; `v`는 27/28 |
| 변조 | n/D/root/C_E/header 1bit 변경, 다른 장치/세션 signature | registry 거부 |
| Lifecycle | expired/revoked/bitstream 변경/consumed session | registry 거부 |
| Mode B E2E | 실제 capture→adapter→proof→submitCommitted | 원본 장치 값 유지; reference 점수와 accepted 점수 일치 |
| 처리량 | 합의된 burst/peak rate, 최대 trace, STOP 후 drain | 실측 backlog, Fmax/자원, signature latency가 합의한 예산 이내 |

인수 보고서에는 보드/bitstream/firmware/ROM SHA-256, SRS ID, clock, debounce/START 정책, trace 입력, 최종 RESULT, contract 주소와 test transaction 또는 로컬 test log를 함께 남긴다. 체크리스트 자체가 실행 증거는 아니다.
