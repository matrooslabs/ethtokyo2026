# 01. 장치 프로토콜 — 바이트 단위 계약

이 문서의 **코드 요구사항**은 현재 Rust/Solidity와 일치해야 한다. **설계 제안**은 원본 코드에 구현되지 않은 장치 동작이다. transport framing은 [03](03-integration.md)에서 별도로 다룬다.

근거: `engine/src/scoring/session.rs`, `api.rs`, `witness.rs::trace_rowmajor`, `field.rs`, `contracts/src/ManiaGkrRegistry.sol`. V1 공통 형식은 현재 빌드 의존성인 `mania-scoring-core`에서 가져온다.

## 1. 입력 단위와 범위

| 항목 | wire 폭 | 유효 범위 / 의미 |
|---|---:|---|
| lane | 1 byte | 0,1,2,3 |
| action | 1 byte | 0 DOWN / 1 UP |
| sequence | 4 bytes | 세션 전체에서 0부터 연속; 마지막 최대 49,999 |
| timestamp_us | 8 bytes | 장치 START 기준 정수 μs, `0 ≤ t ≤ D` |
| event_count `n` | 4 bytes | 0..50,000, 실제 확정 이벤트 수 |
| duration_us `D` | 8 bytes | `maxChartEnd + 136,500 ≤ D ≤ 1,800,000,000` |
| chart notes | 장치 이벤트와 별도 | 1..10,000, 정확히 4레인 |

timestamp는 **전체 이벤트에 대해** 감소하면 안 된다. 같은 μs에 여러 이벤트가 가능하다. 각 레인은 UP에서 시작하고 DOWN/UP이 교대로 나타나야 한다. 최초 UP, 중복 DOWN, 중복 UP은 전체 입력을 무효로 만든다. 종료할 때 DOWN 상태가 남아 있어도 유효하며 가상의 UP을 추가하면 안 된다.

입력 장치는 판정 결과에 따라 이벤트를 버리지 않는다. 노트와 무관한 정상 키 전환도 trace에 들어간다. 가장 가까운 노트 탐색, hit/miss 결정, long-note tail 처리 등은 sidecar scorer가 담당한다.

## 2. 공통 encoding

정수는 unsigned 고정 폭 **big-endian**. ASCII domain은 raw ASCII이고 길이 prefix, NUL, newline이 없다. 해시는 raw 32 bytes, 주소는 raw 20 bytes다. JSON의 hex 문자열/숫자 배열은 테스트·host 표현이며 해시 입력 자체가 아니다.

장치 firmware 내부의 struct alignment, little-endian CPU memory, Rust `serde`, `abi.encode(Header)`를 그대로 해시하면 잘못된 결과다.

### 이벤트 14-byte record

| offset (0-based) | 길이 | 필드 |
|---:|---:|---|
| 0 | 4 | sequence |
| 4 | 8 | timestamp_us |
| 12 | 1 | lane |
| 13 | 1 | action |

예: `seq=1, t=1000, lane=3, action=UP`:

```text
00 00 00 01 | 00 00 00 00 00 00 03 e8 | 03 | 01
```

## 3. SHA-256 trace chain

```text
H0 = SHA256(ASCII("OSUMANIA_TRACE_V1") || sessionId)

H[i+1] = SHA256(
    H[i] || uint32_BE(chunkIndex=i) || uint16_BE(chunkEventCount)
         || eventRecord[0] || ... || eventRecord[count-1]
)

traceRoot = 마지막 H; 이벤트가 없으면 H0
```

seed preimage는 `17 + 32 = 49` bytes다. chunk preimage의 layout:

| offset | 길이 | 필드 |
|---:|---:|---|
| 0 | 32 | 이전 digest |
| 32 | 4 | chunk index |
| 36 | 2 | 이 chunk의 실제 이벤트 수 |
| 38 | `14 × count` | 이벤트 records |

full chunk는 486 bytes이며 SHA padding을 포함하면 compression block 8개다. hash 입력은 chunk마다 **새 SHA-256 메시지**다. 이전 SHA 내부 compression state를 이어 쓰는 방식이 아니라 이전 **최종 digest 32 bytes**를 새 메시지 앞에 넣는다.

| n | 처리할 chunk 수·크기 |
|---:|---|
| 0 | 없음, H0를 그대로 사용 |
| 1 | `[1]` |
| 31 | `[31]` |
| 32 | `[32]`; 종료 시 추가 hash 없음 |
| 33 | `[32,1]` |
| 64 | `[32,32]` |
| 65 | `[32,32,1]` |
| 50,000 | 1,562개의 full chunk + 마지막 16개; index 0..1,562 |

32개가 되면 flush해도 되고 buffering해도 되지만 최종 partition은 반드시 같다. USB 패킷 경계는 이 partition과 무관하다. 마지막 count가 preimage의 이벤트보다 앞에 있으므로 부분 chunk는 count를 아는 시점까지 buffer해야 한다. 최대 이벤트 payload는 448 bytes; double buffer 제안 시 payload RAM 896 bytes에 상태/메타데이터를 더한다.

## 4. Header

`openSession`이 만든 **확정된** `getSession(id).header`를 사용한다. 최초 플레이 전에 고정한다. dry-run에서 예상한 challenge를 사용하지 않는다. header 자체에는 mode나 expiresAt 필드가 없다. mode는 session record에, 입력 정책은 header의 hash에 들어간다.

아래 offset은 **packed header 단독 기준**이다:

| offset | 길이 | Rust / Solidity 이름 | 의미 |
|---:|---:|---|---|
| 0 | 8 | chain_id / chainId | chain ID |
| 8 | 20 | verifier | **ManiaGkrRegistry 주소** |
| 28 | 32 | match_id / matchId | 대회 문맥 |
| 60 | 32 | session_id / sessionId | 이번 세션 ID |
| 92 | 32 | challenge | 이번 세션 challenge |
| 124 | 20 | player | 점수 소유자 |
| 144 | 20 | device | 등록된 secp256k1 signer 주소 |
| 164 | 32 | chart_hash / chartHash | canonical 채보 hash |
| 196 | 32 | ruleset_id / rulesetId | 고정된 채점 규칙 ID |
| 228 | 32 | bitstream_hash / bitstreamHash | 승인된 장치 이미지 식별 값 |
| 260 | 32 | input_policy_hash / inputPolicyHash | A/B 입력 정책 |
| 합계 | **292** | | |

`abi.encode(Header)`는 11 × 32 = **352 bytes**이고 위 packed header와 다르다. CLI `prove-session --header`가 받는 것은 352-byte ABI 표현이다. digest에 쓰는 것은 292-byte packed 표현이다.

hash 상수는 다음 raw ASCII의 SHA-256이다:

```text
ruleset: OSUMANIA_ONCHAIN_RULESET_V1
a1e33a23b0a9e1ee8ce2a50f636ce63e2fc8d49f1f5999e6bf37f48b03ab86e8

policy A: OSUMANIA_INPUT_POLICY_V1
658759391018c1aca1e983f9d91674324ec9391d9c3f897915d1de4b27ecf2a0

policy B: OSUMANIA_INPUT_POLICY_V2_KZG
1dd3e71532319bcca31f8f248bae6a8c8e057cddbd692bfadf3eb06e0ae75460
```

`bitstreamHash`가 어떤 파일/metadata의 어떤 hash인지, secure boot가 실제 이미지를 어떻게 확인하는지는 원본 코드가 정의하지 않는다. 단순히 host가 써 준 32 bytes를 저장하는 것으로 attestation이 성립하지 않는다. provisioning 규격에서 승인 이미지와 값을 결합해야 한다.

## 5. Session digest V2 — 모드 B

```text
digestV2 = SHA256(
  ASCII("OSUMANIA_HARDWARE_SESSION_V2") || uint16_BE(2)
  || packedHeader_B
  || uint32_BE(n) || uint64_BE(D) || traceRoot
  || CE.x_BE32 || CE.y_BE32
)
```

| offset (전체 preimage 기준) | 길이 | 내용 |
|---:|---:|---|
| 0 | 28 | ASCII domain V2 |
| 28 | 2 | `00 02` |
| 30 | 292 | 위 header; policy는 B |
| 322 | 4 | event_count |
| 326 | 8 | duration_us |
| 334 | 32 | traceRoot |
| 366 | 32 | CE.x |
| 398 | 32 | CE.y |
| 합계 | **430** | SHA compression block 7개 (표준 padding 포함) |

`n`, `D`, `traceRoot`, `C_E`는 장치 내부 결과다. `C_E`는 affine canonical 좌표로 변환한 뒤 해시한다. Montgomery 값, Jacobian X/Y/Z, SEC1 prefix, 압축점, decimal/hex 문자열을 넣지 않는다.

V2 preimage에 `srsId`, mode byte, score, judgement counts, laneBits, signature, expiresAt은 직접 들어가지 않는다. mode는 domain/version/policy와 contract session으로 고정되고, SRS는 verifier 배포 및 proof transcript에 묶인다. 장치의 SRS bank는 별도 provisioning으로 고정해야 한다.

## 6. 모드 A 호환

V1은 ASCII domain의 마지막 `V1`, version `00 01`, policy A를 사용하며 좌표 64 bytes가 없다. 전체 preimage는 **366 bytes**이고 SHA padding 포함 6 blocks다.

모드 A에서 `submitCalldata`는 전체 trace를 받고 SHA root를 다시 계산한다. 모드 B에서 `submitCommitted`는 root와 CE를 서명된 값으로 받는다. **모드 B의 proof는 CE에 대한 채점 관계를 증명하지만 SHA(root)와 CE의 동일 trace 유래를 증명하지 않는다.** 양쪽 계산의 일치는 trusted device가 보장해야 한다.

## 7. 장치 서명

contract는 `ecrecover(digest, v, r, s)`를 사용한다. 요구되는 곡선은 **secp256k1**이며 KZG의 **BN254**와 별개다. `digest`는 위 SHA-256의 32-byte 결과 그대로다. Ethereum personal-message prefix, EIP-191, 추가 SHA-256을 적용하면 안 된다.

```text
signature = r_BE32 || s_BE32 || v_u8   // 65 bytes
v = 27 또는 28                        // hex 1b 또는 1c
s ≤ 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
```

DER를 출력하는 소자를 쓰는 경우 필요한 adapter 작업:

1. ASN.1 SEQUENCE의 양수 INTEGER r,s를 해석하고 sign padding을 제거한 뒤 각각 32-byte BE로 패딩한다.
2. secp256k1 group order `n_secp = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`에 대해 r/s 유효성을 확인한다.
3. s가 half-order보다 크면 `s := n_secp - s`로 정규화한다.
4. **정규화된** r,s와 raw digest에서 복원한 공개키가 등록된 장치 공개키와 일치하는 v=27/28을 선택한다. 기존 recovery parity를 유지하면서 s만 뒤집으면 안 된다. 두 후보 모두 불일치하면 제출하지 않는다.
5. raw 공개키의 Ethereum 주소가 header.device와 일치하는지 확인한다. 주소 hash는 Ethereum Keccak-256이며 NIST SHA3-256이 아니다.

DER 변환과 v 산출은 비밀키가 없어도 가능한 작업이므로 sidecar에서 수행할 수 있다. 반면 서명할 digest 결정 권한은 신뢰되는 장치 경계 안에 있어야 한다. 정확한 SE050 SKU의 secp256k1/raw-prehash 지원, 키 정책과 실제 API는 이 저장소에서 확인할 수 없으며 부품 검증 항목이다. 구현된 SE050 드라이버가 있다고 가정하지 않는다.

## 8. 채점 의미 중 장치가 알아야 할 부분

장치는 chart 판정을 계산할 필요가 없지만 종료 시각과 입력 보존 규칙은 알아야 한다. window 상한은 모두 inclusive이며 `[19500,49500,82500,112500,136500] μs`, 점수 가중치는 `[320,300,200,100,50,0]`이다. tap 1개, hold 2개 component를 갖는다.

같은 lane에서 가장 이른 미처리 head만 DOWN에 매칭된다. 첫 UP에서 tail 판정이 확정되며 재입력으로 되돌리지 않는다. 이 규칙을 흉내 내어 장치가 edge를 정리하면 안 된다. `duration+1`은 scorer의 종료 시 MISS 처리용 가상 시각이며 기록 duration이나 마지막 이벤트 시각을 1 늘리라는 지시가 아니다.
