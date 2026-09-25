# 참고: 장치 commitment가 채점 증명에 연결되는 방식

이 문서는 FPGA 입력 장치의 필수 구현 범위 밖이다. 장치가 만들어야 하는 것은 [01](01-device-protocol.md)과 [02](02-kzg-hardware.md)의 event/SHA/C_E/digest다. Host prover를 나중에 가속하거나 sidecar 연동을 디버깅할 때 이 내용을 사용한다.

## 1. 채점의 결정성과 lane timeline

4개 lane을 독립 상태기계로 실행하지만 이벤트 sequence는 전체 입력에서 하나다. Chart는 `(start_us, lane)` 순서이며 동일 lane의 다음 start는 이전 end보다 커야 한다. Tap은 head 하나, hold는 head와 tail 두 component를 가진다.

DOWN은 해당 lane에서 아직 처리하지 않은 가장 이른 노트에 대한 시도다. 가장 가까운 노트를 검색하지 않는다. 판정창은 절대 오차 기준으로 `19500, 49500, 82500, 112500, 136500` microseconds이며 경계를 포함한다. 각각 320/300/200/100/50점, 그 밖은 MISS다. Hold head miss는 두 component 모두 miss이고, 성공한 hold의 첫 release가 tail 결과를 확정한다. 마지막에 `D+1` 시점으로 만료를 처리하므로 `D >= maxEnd + 136500` 조건이 중요하다.

`witness.rs`는 이벤트와 노트 만료를 lane timeline row로 만들고 `relation.rs`가 각 row의 상태 전이·범위·판정을 제약한다. Chart/Trace/Lane/Byte table 사이의 데이터 일치를 logUp lookup으로 연결한다. `core::evaluate`와의 차등 테스트가 V1 의미를 보존하는지 검사한다.

최종 component 수를 C라 하면:

```text
MISS = C - (J320 + J300 + J200 + J100 + J50)
achieved = 320 J320 + 300 J300 + 200 J200 + 100 J100 + 50 J50
score = floor(1,000,000 × achieved / (320 C))
```

## 2. Witness table 및 크기

`adv`는 prover advice, `src`는 chart/trace commitment에서 오는 컬럼, `pub`는 verifier가 계산하는 public 컬럼이다. `slots`는 logUp의 분수 항 개수다.

| Table | row bits | adv | src | pub | width | slots | constraints | advice column slots |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Lane 0 | R_L0 | 23 | 0 | 3 | 26 | 12 | 23 | 32 |
| Lane 1 | R_L1 | 23 | 0 | 3 | 26 | 12 | 23 | 32 |
| Lane 2 | R_L2 | 23 | 0 | 3 | 26 | 12 | 23 | 32 |
| Lane 3 | R_L3 | 23 | 0 | 3 | 26 | 12 | 23 | 32 |
| Chart | R_N | 32 | 5 | 1 | 38 | 18 | 25 | 32 |
| Trace | R_E | 5 | 3 | 4 | 12 | 7 | 3 | 8 |
| Byte | 8 | 1 | 0 | 1 | 2 | 1 | 0 | 1 |

총 advice 컬럼은 130, source 컬럼은 8, opening으로 연결할 claim은 **138**, slot은 74, constraint는 120이다.

```text
R_Li = ceil_log2(n_i + 2 m_i)   // empty table도 최소 1 row, ceil_log2(0)=0
R_N  = ceil_log2(m)
R_E  = ceil_log2(n + 1)         // n 다음 sentinel row 확보
Rmax = max(R_L0..R_L3, R_N, R_E, 8)
```

Advice table block 크기는 `2^(row_bits + ceil_log2(adv_columns))`. Block을 크기 내림차순, 같은 크기면 table index 순으로 놓고, block 안에서는 **column-major**로 배치한다. 전체 길이를 다음 2의 거듭제곱으로 zero-pad한다.

Chart source commitment는 한 row 8개 계수, Trace source commitment는 한 row 4개 계수의 **row-major**다. Chart의 실제 source는 5컬럼이고 나머지는 0, Trace는 `t,lane,act,0`이다. 둘은 advice block과 메모리 배치가 다르다.

`A = max(advice 전체 bits, 3 + R_N, 2 + R_E)`가 Zeromorph opening 변수 수다. Leaf slot도 각 table의 row 수를 기준으로 크기 내림차순/table/slot 순서로 놓는다. `G = max(1, ceil_log2(전체 leaf 수))`이며 미사용 leaf는 `p=0,q=1`이다.

**Padding 주의:** lane table 자체의 padding은 마지막 상태를 이어갈 수 있다. Trace witness sentinel에는 이전 시각과 D까지 gap이 존재한다. 이들을 “모두 0”으로 바꾸면 relation이 달라진다. 반면 장치 C_E의 실제 계수는 오직 이벤트 row이고 이후 계수는 0이다. Row sumcheck가 서로 다른 크기 table을 Rmax로 확장할 때의 zero padding도 원래 table padding과 별개다.

## 3. 증명 흐름

1. **Advice commitment C_A.** 모든 advice 컬럼을 정해진 layout으로 묶고 SRS에 commit한다.
2. **Statement를 transcript에 absorb.** Chart C_N, 모드 B의 C_E, C_A와 세션 digest를 모두 묶는다.
3. **logUp-GKR.** `alpha,gamma`로 lookup tuple을 압축한다. `Σ p_i/q_i=0`을 분수 합 트리로 증명한다. 부모는 `p=p0*q1+p1*q0, q=q0*q1`. Root numerator=0, denominator≠0을 검사한 뒤 leaf claim까지 내려간다.
4. **Row sumcheck.** GKR leaf 평가, 각 table의 constraints, judgement counts를 무작위 결합한다. 최대 degree 4, Rmax rounds다. 마지막에 각 advice/source 컬럼의 evaluation claim 138개를 보낸다.
5. **Opening reduction.** `mu`로 claim들을 결합하고 degree 2, A rounds의 sumcheck로 advice/chart/trace를 같은 opening point에 모은다.
6. **Batched Zeromorph.** `nu`로 mode A는 `ADV + nu*Chart`, B는 `ADV + nu*Chart + nu²*Trace`를 만든다. Multilinear evaluation을 quotient와 univariate KZG opening/degree bound로 검증한다.

모드 A에서 Trace의 최종 evaluation은 calldata로 verifier가 직접 계산한다. 모드 B에서는 서명된 C_E가 위 batch에 들어간다. 그래서 다른 trace로 witness를 만들어도 해당 commitment와 opening이 일치하지 않으면 proof가 거부된다. 단, SHA root와 C_E의 동일 trace 관계는 장치 신뢰 경계에서 보장한다.

## 4. Transcript/field 구현 규칙

Field 산술은 BN254 scalar field Fr이다. Event와 header 해시는 SHA-256, **proof transcript는 Keccak-256**이다. SHA3-256로 대체하면 안 된다.

```text
state = keccak256("OSUMANIA_GKR_V1")
absorb(words) : state = keccak256(state || word0_BE32 || ... || wordK_BE32)
squeeze()    : state = keccak256(state); challenge = integer_BE(state) mod r
```

흡수 단위의 grouping도 프로토콜이다. `absorb([a,b])`와 `absorb([a]); absorb([b])`는 다르다. State 자체는 256-bit hash를 보관하고 challenge만 mod r로 줄인다.

최초 statement absorb는 A 22 words, B 24 words를 **한 번에** 넣는다:

```text
[version=1, mode, sessionDigest, n, D, m, R_N, components,
 R_L0, R_L1, R_L2, R_L3,
 J320, J300, J200, J100, J50,
 srsId, C_N.x, C_N.y, (C_E.x, C_E.y), C_A.x, C_A.y]
```

Chart registration은 별도 `OSUMANIA_GKR_CHART_V1` domain을 사용한다.

주요 challenge/message 순서는 다음과 같다. 실제 구현을 이식할 때는 [prover](../../engine/src/scoring/prover.rs), [logup_gkr](../../engine/src/logup_gkr.rs), [zeromorph](../../engine/src/zeromorph.rs)와 verifier의 호출 순서를 그대로 대조한다.

| 단계 | 메시지와 challenge |
|---|---|
| lookup | statement→alpha→gamma |
| GKR 시작 | layer1 4 values absorb→tau |
| GKR layer k=1..G−1 | lambda→k번 `[g(0),g(2),g(3)]` absorb와 round challenge→children `[p0,p1,q0,q1]` absorb→tau |
| row | lambda→beta→zeta→kappa→Rmax개의 eq-point challenge→Rmax번 round message/challenge→138 claims absorb |
| reduction | mu→A번 `[g(0),g(2)]` absorb/challenge→ADV/Chart/(Trace) final evaluations absorb |
| opening | nu→Zeromorph q commitments→y→qhat/qhat_shift→x,z→pi→rho |

Sumcheck 메시지는 **다항식 계수 배열이 아니다.** 평가값 `g(0),g(2),...`이며 `g(1)=현재 claim−g(0)`으로 복원한다. Row는 `[g(0),g(2),g(3),g(4)]`를 보낸다.

MLE는 인접 원소 `(2i,2i+1)`를 먼저 fold하는 LSB-first다. `q_0..q_(A−1)` commitment도 정해진 낮은 index 순으로 직렬화한다. Upstream fork의 polynomial representation/bit order와 혼용하지 않는다.

## 5. Proof 직렬화

`encode::proof_words` 기준, 모든 field는 canonical Fr BE32, G1은 canonical affine x/y 각각 한 word다. Proof는 아래 순서이며 길이 prefix나 round index가 없다. Shape로 개수를 계산한다.

```text
C_A                                      2 words
GKR layer1                               4
GKR k=1..G−1                             각 3k + 4
row sumcheck                             4 Rmax
claims                                   138
reduction sumcheck                       2 A
adv_eval, chart_eval [, trace_eval]       2 또는 3
Zeromorph q_0..q_(A−1)                    2 A
qhat, qhat_shift, pi                      6
```

따라서 총 words는 `2 + 4 + Σ(k=1..G−1)(3k+4) + 4Rmax + 138 + 2A + (2 또는 3) + 2A + 6`. `laneBits`와 `counts`는 별도 Submission ABI다. Decode는 noncanonical field/G1, 부족한 words와 trailing words를 거부한다.

## 6. 향후 prover 가속의 판단 기준

입력 장치의 C_E는 작은 정수 scalar의 순차 누적이다. Prover는 큰 dense array의 field 연산과 full-width Fr scalar MSM을 반복하므로 같은 가속 요구사항이 아니다.

현재 코드의 측정 분해는 witness, advice MSM, fractional GKR, row sumcheck, reduction, Zeromorph opening이다. 기존 README benchmark에서는 opening이 가장 큰 부분을 차지한다. 해당 수치는 과거 CPU 실험이고 이번에 보드에서 재측정한 결과가 아니다. `api::prove`의 `total_ms`는 mode B의 별도 C_E 계산을 포함하지 않는다.

후속 가속을 한다면 실제 workload의 `Shape`, A/G/Rmax, 배열 크기, MSM 시간, 메모리 bandwidth를 먼저 재측정한다. Board를 정하기 전에는 속도 향상 배수나 DSP/BRAM 수를 약속할 수 없다. 현재 handoff의 1차 완료 조건은 **정확한 물리 입력·SHA·mode B commitment·signature 경로**다.
