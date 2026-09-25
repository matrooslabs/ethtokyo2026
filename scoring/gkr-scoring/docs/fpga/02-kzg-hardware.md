# 02. 모드 B KZG commitment 하드웨어

## 1. 장치가 계산하는 수식

```text
P[i] = [τ^i]₁                         // 승인된 SRS G1 bank
TRACE[4j + 0] = timestamp_us[j]
TRACE[4j + 1] = lane[j]
TRACE[4j + 2] = action[j]
TRACE[4j + 3] = 0

C[0] = G1 identity
C[j+1] = C[j] + t[j]·P[4j] + lane[j]·P[4j+1] + action[j]·P[4j+2]
C_E = C[n]
```

참조 구현: `witness.rs::trace_rowmajor` → `api.rs::device_trace_commitment` → `Srs::commit` → `Srs::commit_at` → `halo2curves::msm::msm_best`.

software API는 vector 전체를 만드는 batch MSM이지만 위 streaming 합과 같다. 새 [fpga_vectors.rs](../../engine/examples/fpga_vectors.rs)는 streaming 누적 결과와 기존 dense MSM 결과가 같은지 assert한다.

여기서 commitment 대상 univariate 다항식은 `U_TRACE(X) = Σ_i TRACE[i]·X^i`다. 동일한 array를 이후 multilinear evaluation table로도 사용하지만 장치는 그 배열을 **monomial coefficient**로 SRS에 곱한다. Roots-of-unity evaluation, Lagrange-basis SRS 또는 FFT 변환을 끼워 넣으면 다른 commitment가 된다.

핵심은 `j`가 **chunk-local index나 lane-local index가 아닌 세션 전체 event index**라는 것이다. seq는 KZG의 scalar slot에 직접 넣지 않는다. `j=seq`가 장치 내부에서 보장되고 seq는 SHA record에는 들어간다.

| event j | timestamp 점 | lane 점 | action 점 | zero slot |
|---:|---:|---:|---:|---:|
| 0 | P[0] | P[1] | P[2] | P[3] |
| 1 | P[4] | P[5] | P[6] | P[7] |
| 31 | P[124] | P[125] | P[126] | P[127] |
| 32 | P[128] | P[129] | P[130] | P[131] |
| 49,999 | P[199,996] | P[199,997] | P[199,998] | P[199,999] |

이벤트 scalar가 0이어서 덧셈을 생략해도 index는 반드시 4씩 진행한다. 타임스탬프 차분, SHA digest, 14-byte record 전체를 한 scalar로 변환해 사용하는 것은 호환되지 않는다.

후속 zero padding은 commitment를 바꾸지 않는다. 장치가 `R_E`, laneBits, ADV layout을 알 필요가 없다. 장치가 session 종료 전 trace 길이를 알아야 할 필요도 없다.

## 2. BN254 산술과 encoding

기호를 구분한다. 원본 Solidity에서 scalar prime을 `R`, pairing 내부 base prime을 `Q`라 부른다.

```text
base field q (G1 x,y 산술):
21888242871839275222246405745257275088696311157297823662689037894645226208583
0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47

scalar field r (G1 scalar / proof field):
21888242871839275222246405745257275088548364400416034343698204186575808495617
0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001

G1 curve: y² = x³ + 3 mod q
generator: (1,2)
wire identity: (0,0)
```

두 prime은 254 bits이고 wire word는 256 bits다. `q`와 `r`를 혼동한 modular multiplier는 잘못된 점을 만든다. 운영 입력 범위에서 `t < 2^31`, lane은 2 bits, action은 1 bit이며 모두 `r`보다 작다. 장치의 scalar 값에 별도의 hash-to-field는 없다.

G1 wire 형식은 `x_BE32 || y_BE32`, 64 bytes다. `0x04` SEC1 prefix나 compressed point sign bit를 넣지 않는다. identity는 64 zero bytes이며, 실제 유효 결과가 될 수 있다:

- n=0이면 identity.
- 첫 이벤트가 `t=0,lane=0,DOWN`이면 세 scalar가 모두 0이라 n=1이어도 identity.

따라서 `C_E==(0,0)`만으로 장치 실패를 판정하면 안 된다. n은 digest에 따로 들어가므로 두 사례의 서명 digest는 다르다. 합산 중 identity, 동일점 doubling, 반대점 합도 올바르게 처리해야 한다.

### 제안하는 산술 datapath

기능 일치가 우선인 초기 구조는 ROM의 affine 점과 projective accumulator를 사용하는 구조다. 예를 들어 Jacobian을 선택하면 `x=X/Z²`, `y=Y/Z³ mod q`; 완료 시 inversion 1회와 몇 번의 곱셈으로 affine 변환한다. 다른 projective 표현도 가능하지만 **좌표 변환식을 섞으면 안 된다**.

```text
event FIFO → SRS fetch → timestamp scalar multiplication
                       → lane contribution (0/P/2P/3P)
                       → action contribution (0/P)
                       → G1 accumulator → final affine normalization → canonical BE output
```

timestamp binary multiplication은 최대 31-bit scalar를 처리하면 된다. 레인 0/1/2/3은 small-case mux/add/double로, action은 0/1 선택으로 처리 가능하다. clock 수, multiplier 수, window 크기는 보드별 합성 결과로 결정한다. 이 문서는 LUT/DSP/Fmax 또는 μs/event 실측치를 제공하지 않는다.

원본 README의 “fixed-base scalar multiplication”은 **사전에 정해진 여러 SRS 점**에 대한 연산이라는 뜻이다. 모든 이벤트가 동일한 generator base를 쓰는 것은 아니다. `τ`를 알아내어 `[Σ scalar·τ^i]G`로 계산하는 최적화는 운영에서 사용할 수 없다. SRS의 τ는 누구도 알고 있지 않아야 한다.

RTL 내부 Montgomery 산술은 허용되지만 `q`, radix, limb 순서, Montgomery factor를 명시하고 경계에서 변환한다. 외부 좌표는 항상 canonical integer다. 이 입력 장치에는 G2 연산, pairing, Zeromorph opening, sumcheck, MiMC, FFT/NTT가 필요하지 않다.

## 3. SRS 크기와 memory layout

현재 제한 50,000개 event에서 실사용하는 최대 exponent는 **199,998**이다. 다음 저장 정책 중 하나를 선택할 수 있다:

| 저장 정책 | 점 수 | 점당 64 bytes일 때 | 비고 |
|---|---:|---:|---|
| 단순 contiguous 4-slot bank | 200,000 | 12,800,000 B ≈ 12.21 MiB | 사용하지 않는 c=3도 저장 |
| 명세의 power-of-two prefix | 262,144 = 4×2^16 | 16,777,216 B = 16 MiB | 원본 설명과 가장 단순하게 대응 |
| event당 3개 점만 저장 | 150,000 | 9,600,000 B ≈ 9.16 MiB | 주소 변환 `3j+c → 원본 exponent 4j+c`; 별도 manifest 필요 |

위 값은 **장치 trace commitment용** bank다. sidecar prover의 전체 SRS `2^Smax`개와 다르다. 예를 들어 Smax=22의 G1만 256 MiB이며, G2 key와 파일 header가 추가된다. 장치가 16 MiB bank를 쓴다고 prover의 Smax를 18로 줄여도 된다는 뜻이 아니다.

contiguous BE ROM에서 `P[i]`의 byte offset은 `64*i`, y는 그 뒤 32 bytes다. event j의 timestamp/lane/action 주소는 각각 `256j`, `256j+64`, `256j+128`; `256j+192`는 zero slot이라 읽을 필요가 없다. zero scalar의 점 읽기도 생략할 수 있지만 banking/address logic의 event index는 유지한다.

## 4. SRS 생성·검증·provisioning

원본에는 두 경로가 있다:

- `Srs::insecure_dev(smax, seed)`: 공개 seed로 τ 생성. 반복 가능한 검증 전용.
- `Srs::from_ptau(path, smax)`: `.ptau`에서 점을 읽고 curve/generator/일부 pairing consistency를 확인.

`Srs::check_consistency`는 모든 인접 G1 powers를 검사하지 않는다. 고정 위치 4개와 **고정 seed의 표본 8개**, 모든 저장 G2 shift를 확인한다. 전체 ceremony transcript 검증이나 공급망 진위를 증명하는 루틴으로 해석하면 안 된다. `Srs::load`는 trusted local file을 가정하고 raw points를 unchecked로 읽는다.

`MGKRSRS1` 파일 layout은 magic 8 bytes, smax LE4, G2 one/tau 및 smax+1개 shift, G1 bank다. raw 점 직렬화는 halo2curves 내부 representation을 사용하며 canonical BE ROM과 다르다. 파일 offset만 계산해 해당 bytes를 FPGA affine ROM으로 복사하지 않는다.

추가 exporter 사용 예 (`gkr-scoring/`에서 실행):

```sh
# 테스트 벡터 재생성: 내부에서 INSECURE dev SRS를 만든다.
cargo run --release --locked --example fpga_vectors -- --out artifacts/fpga-test

# 이미 별도 승인한 SRS에서 FPGA용 canonical 16 MiB G1 prefix 추출.
# 이 명령은 provenance를 인증하지 않는다. 기존 SRS loader를 사용한다.
cargo run --release --locked --example fpga_vectors -- \
  --srs artifacts/approved-srs.bin --points 262144 --out artifacts/fpga-rom
```

결과 `srs-g1-be.bin`은 canonical BE64/point이고 manifest에 pointCount, SHA-256, SRS id, Smax가 있다. exporter는 임의 local SRS를 운영용으로 인증하지 않으며, 제공 벡터의 SRS는 **Smax=10, seed=20260925의 개발용**이다. 260개 점만 제공하므로 최대 65-event 검증용이다.

### 운영 provisioning 제안

1. crypto/software 담당자가 ceremony provenance와 전체 SRS 승인 절차를 수행한다.
2. verifier가 사용하는 G2 key·Smax·srsId와 정확히 같은 SRS에서 G1 prefix를 추출한다.
3. 승인 manifest에 ROM hash, 점 수, 표현, index 규칙, FPGA 이미지/firmware 버전, 대상 registry/verifier를 기록한다.
4. 장치가 승인 manifest에 묶인 ROM만 사용하도록 secure boot 또는 동등한 신뢰 경로로 고정한다. untrusted host의 임의 bank 교체를 허용하지 않는다.
5. ARM 전 ROM integrity/설정 일치를 검사하고 capture 동안 bank 교체를 금지한다.

`srsId = Keccak256(G2_tau || shift[1] || ... || shift[Smax])`; 각 G2는 EVM 순서 `x.c1,x.c0,y.c1,y.c0`, 각각 32-byte BE다. **srsId는 ROM 파일 hash가 아니다.** 기존 V2 digest에 srsId가 직접 없으므로 추가 보안 정책을 넣으려면 provisioning에서 결합한다. 서명 preimage에 임의로 필드를 추가하면 기존 contract와 호환되지 않는다.

## 5. 처리량 예산 — 계산값과 보드 측정값을 구분

원본은 최대 n과 D만 제한하며 최소 edge 간격이나 burst를 제한하지 않는다. **50,000 events / 30분**이라는 평균으로 FIFO/연산 성능을 설계할 수 없다. 같은 μs에 여러 레인 이벤트도 허용된다.

다음은 속도 목표가 아닌 설계 계산식이다:

```text
λ_peak = debounce·arbitration 정책으로 정한 최악의 sustained events/s
service = FPGA가 sustained로 완료하는 commitments/s
safe operation: service > λ_peak, 또는 전량 신뢰 저장 후 후처리

raw trace bandwidth = 14 × λ_peak bytes/s (+ transport framing)
SRS bandwidth ≤ 192 × λ_peak bytes/s (3 affine points/event; zero skips 제외)
FIFO capacity ≥ max over time(arrivals - serviced)
```

예시로 10,000 events/s라는 **가정**을 선택하면 trace 140 kB/s, 점 fetch 1.92 MB/s, full chunk 약 312.5개/s다. 이 가정은 입력 정책이 아직 결정되지 않았으므로 제품 요구사항이나 달성 결과가 아니다.

full SHA chunk는 8 compression blocks/32 events = 평균 0.25 blocks/event이며 ECC 쪽이 더 많은 산술을 요구할 가능성이 있다. 실제 병목은 보드에서 측정해야 한다. KZG engine이 늦어져도 timestamp를 서비스 완료 시각으로 바꾸면 안 된다. capture 시각을 먼저 고정하고 독립 queue에서 계산한다.

전체 이벤트를 신뢰 영역에 저장한 뒤 commitment를 계산하는 대안도 가능하다. 최대 trace payload는 **700,000 bytes ≈ 683.59 KiB**. 이 경우 종료 후 지연과 보호된 memory가 필요하며, untrusted host가 돌려준 trace를 검증 없이 commitment 입력으로 쓰면 안 된다. 초기 구현에는 streaming + 신뢰되는 backlog FIFO를 제안한다.

## 6. RTL 인터페이스 제안

기존 wire API가 아니라 팀 간 합의를 위한 내부 신호 제안이다:

| 블록 경계 | 데이터 | 제어·불변식 |
|---|---|---|
| capture → fanout | seq32, time64, lane2, act1 | valid/ready; event 확정 시 값 불변 |
| fanout → SHA | 같은 event | 각 event 정확히 1회 처리 |
| fanout → KZG | 같은 event + j | SHA와 독립 latency, 최종 처리 수 일치 |
| KZG → finalizer | x256,y256 | `done`, `processed_count`, sticky error |
| SHA → finalizer | root256 | partial chunk 완료 후 `done`, count |
| finalizer → signer | digest256 | header locked, SHA/KZG drain 완료, 오류 없음 |

`ready`가 낮다고 physical edge가 없어지는 것은 아니다. capture에서 먼저 timestamp를 저장하고 FIFO overflow는 sticky fault로 처리한다. `captured_count == sha_count == kzg_count == footer.n`이 아니면 final signature가 나오지 않도록 한다. 이 count 검사는 보조 검증이며, 공유 immutable record 경로와 중복·누락 방지 로직이 함께 필요하다.
