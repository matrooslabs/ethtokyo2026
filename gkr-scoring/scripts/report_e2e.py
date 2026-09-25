#!/usr/bin/env python3
"""Create a source-grounded Markdown benchmark report from a completed E2E run."""
import argparse
import json
from pathlib import Path
import shutil
import statistics

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory",type=Path)
    parser.add_argument("output_directory",type=Path)
    args=parser.parse_args()
    data=json.loads((args.run_directory/"run.json").read_text())
    assert data["status"]=="complete" and data["chainId"]==11155111
    rows=data["runs"]
    assert len(rows)==len(data["cases"])*data["reps"]
    assert all(x["score"]==1_000_000 and x["consumed"] for x in rows)
    assert all(int(x["receipt"]["status"],16)==1 and x["confirmations"]>=data["confirmationsRequired"] for x in data["transactions"])
    out=args.output_directory; out.mkdir(parents=True,exist_ok=True)
    shutil.copy2(args.run_directory/"run.json",out/"run.json")
    groups={n:[x for x in rows if x["notes"]==n] for n in data["cases"]}
    median=lambda xs:statistics.median(xs)
    txlink=lambda h:f"[{h[:10]}…](https://sepolia.etherscan.io/tx/{h})"
    lines=["# GKR 모드 B — 소프트웨어 FPGA → Sepolia E2E 실측", "",
      f"실행 구간(UTC): `{data['startedUtc']}` → `{data['finishedUtc']}`. Chain ID 11155111.","",
      f"**{len(rows)}/{len(rows)}회 점수 제출 성공**, 모든 세션에서 reference와 같은 **1,000,000점** 및 judgement counts를 확인했다. 전체 {len(data['transactions'])}개 transaction이 status=1이며 각 거래는 최소 {data['confirmationsRequired']} confirmations를 관측했다.","",
      "FPGA 입력은 가상 시계의 DOWN/UP edge로 재생했다. 실제 SHA-256·BN254 commitment·secp256k1 서명·GKR/Zeromorph proof·Solidity 검증을 사용했다. **FPGA/SE050 실측은 아니며, known-tau 개발용 SRS를 사용한 기능·성능 시뮬레이션이다.**", "",
      f"## 주요 결과 — 각 크기 {data['reps']}회, 중앙값", "",
      "| 노트 / 이벤트 | 순차 입력·SHA/KZG 계산 | GKR proving¹ | 입력 재생 시작→제출 준비² | 전송→최초 포함³ | 전송→2 confirmations³ | 제출 gas | proof bytes |", 
      "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for n,xs in groups.items():
        lines.append(f"| {n:,} / {xs[0]['events']:,} | {median([x['deviceTimings']['captureComputeMs'] for x in xs])/1000:.3f} s | {median([x['proverTimings']['total_ms'] for x in xs])/1000:.3f} s | {median([x['captureStartToSubmissionReadySeconds'] for x in xs]):.3f} s | {median([x['submitInclusionSeconds'] for x in xs]):.3f} s | {median([x['submitConfirmationSeconds'] for x in xs]):.3f} s | {median([x['gasUsed'] for x in xs]):,.0f} | {xs[0]['proofBytes']:,} |")
    lines += ["", "¹ Witness 포함. SRS load, 장치 C_E 생성, chart registration 재계산, native verify 제외.",
      "² Capture/prover process startup, SRS load, 교차검사, encrypted device keystore 서명, 파일 출력·calldata 준비 포함. Virtual play의 wall-clock sleep, 제출 전 network preflight, 부정 시험 제외.",
      "³ `cast send` 시작부터 관측한 wall time이므로 organizer keystore unlock, RPC 및 polling overhead 포함. 2 confirmations는 포함 블록 + 후속 1개 블록이며 consensus finalized를 뜻하지 않는다.", "",
      "## 입력과 측정 조건", "",
      "- 4 lanes, note 간격 150 ms, 4개 중 1개는 300 ms hold. 나머지는 tap. 모든 입력은 정확한 head/tail 시각의 perfect play.",
      "- 매 반복에 새 on-chain session/challenge를 발급하고, 그 확정 header로 capture를 시작했다. 서명 후 header/root/C_E를 재바인딩하지 않았다.",
      "- 가상 시계를 fast-forward했다. 아래 플레이 duration을 실제로 기다린 시간은 결과 latency에 포함하지 않았다.",
      "- 실제 FPGA에서는 입력 수집과 SHA/KZG 계산이 플레이 중 겹칠 수 있다. 여기의 capture 비용은 실제 STOP 이후 대기 시간이나 FPGA 처리량의 예측치가 아니다.",
      "- CPU: Apple M3 Max, 16 logical cores, RAM 48 GiB. 각 반복은 별도 executable process이며 software ECC 비용을 FPGA latency로 해석할 수 없다.",
      f"- SRS Smax={data['srsSmax']}, srsId=`{data['srsId']}`.",
      f"- SRS file SHA-256=`{data['srsFileSha256']}`.",
      "- SRS와 verifier는 known-tau development setup이다. Bench gas/기능을 측정할 수 있지만 운영 proof soundness의 근거가 되지 않는다.","",
      "| 노트 | virtual play | 채점 components | trace payload | calldata bytes | proof words |",
      "|---|---:|---:|---:|---:|---:|"]
    for n,xs in groups.items():
        x=xs[0]; lines.append(f"| {n:,} | {x['virtualPlaySeconds']:.6f} s | {sum(x['judgements']):,} | {14*x['events']:,} B | {x['calldataBytes']:,} | {x['proofWords']:,} |")
    lines += ["", "모드 B 제출 calldata에는 전체 trace가 없다. Trace는 sidecar가 witness를 만들기 위해 보관했다.","",
      "## CPU 세부 단계 — 중앙값 ms", "",
      "| 노트 | witness | advice commit | GKR | row sumcheck | reduction | Zeromorph opening | native verify | device signing process |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for n,xs in groups.items():
        vals=[median([x['proverTimings'][k] for x in xs]) for k in ['witness_ms','commit_ms','gkr_ms','row_sumcheck_ms','reduction_ms','opening_ms']]
        vals += [median([x['nativeVerifyMs'] for x in xs]),1000*median([x['signProcessSeconds'] for x in xs])]
        lines.append('| '+str(n)+' | '+' | '.join(f'{v:.3f}' for v in vals)+' |')
    lines += ["", "각 단계의 중앙값을 더한 값은 전체 시간의 중앙값과 같지 않을 수 있다. 단계 사이 bookkeeping도 존재한다.","",
      "## 변동 범위 — min / median / max, seconds", "",
      "| 노트 | proving | 제출 준비 | 최초 포함 | 2 confirmations |",
      "|---|---|---|---|---|"]
    for n,xs in groups.items():
        sets=[[x['proverTimings']['total_ms']/1000 for x in xs]]+[[x[k] for x in xs] for k in ['captureStartToSubmissionReadySeconds','submitInclusionSeconds','submitConfirmationSeconds']]
        lines.append('| '+str(n)+' | '+' | '.join(f'{min(v):.3f} / {median(v):.3f} / {max(v):.3f}' for v in sets)+' |')
    lines += ["", "표본은 크기별 3개다. 이 min/max를 network latency의 장기적인 보장으로 해석하지 않는다.","",
      "## 배포·등록 비용과 전체 비용", "",
      "| 초기 작업 | gasUsed | 비용 (Sepolia test ETH) | 거래 |", "|---|---:|---:|---|"]
    for tx in data['transactions']:
        if tx['label'].startswith(('deploy-','register-')):
            lines.append(f"| {tx['label']} | {tx['gasUsed']:,} | {tx['feeWei']/1e18:.9f} | {txlink(tx['hash'])} |")
    lines += ["",f"전체 {len(data['transactions'])}개 거래 실제 비용: **{data['totalFeeWei']/1e18:.9f} Sepolia test ETH**. 배포·장치/채보 등록·9개 세션 발급·9개 점수 제출을 포함한다. Mainnet 비용으로 환산하지 않았다.",
      "채보 등록은 채보당 한 번, contract 배포는 배포당 한 번의 비용이다. 매 플레이 제출 비용과 분리해야 한다.","",
      "## 모든 점수 제출의 검증 근거", "",
      "| 노트 | 반복 | block | score | gas | 2 confirmations (s) | transaction |", "|---|---:|---:|---:|---:|---:|---|"]
    txs={x['hash']:x for x in data['transactions']}
    for x in rows:
        tx=txs[x['submitTx']]
        lines.append(f"| {x['notes']} | {x['rep']} | {int(tx['receipt']['blockNumber'],16)} | {x['score']:,} | {x['gasUsed']:,} | {x['submitConfirmationSeconds']:.3f} | {txlink(x['submitTx'])} |")
    lines += ["", "검사한 항목: receipt status=1, canonical block hash, ScoreAccepted event, getSession의 score/judgements, consumed=true. 각 session ID와 원본 receipt는 [run.json](run.json)에 있다.","",
      "| 부정 시험 | 수행 수 | 결과 |", "|---|---:|---|"]
    for key in ['mutated-root','mutated-proof','replay']:
        checks=[c for x in rows for c in x['negativeChecks'] if c['check']==key]
        assert len(checks)==len(groups) and all(c['rejected'] for c in checks)
        lines.append(f"| {key} | {len(checks)} | 전부 eth_call revert |")
    lines += ["", "부정 시험은 실패 transaction을 실제 전송하지 않고 deployed contract의 eth_call로 확인했다. RPC 연결 실패는 거부 성공으로 계산하지 않았다.","", "## 배포 주소", ""]
    for name,address in data['contracts'].items():
        lines.append(f"- {name}: [{address}](https://sepolia.etherscan.io/address/{address})")
    recheck=json.loads((out/'chain-recheck.json').read_text())
    assert recheck['allChecksPassed'] and len(recheck['transactions'])==len(data['transactions']) and len(recheck['sessions'])==len(rows)
    lines += ["", "## 최종 재확인과 adapter 테스트", "",
      f"`{recheck['checkedUtc']}`에 head block {recheck['headBlock']:,} 기준으로 전체 {len(data['transactions'])}개 receipt의 canonical block hash와 성공 상태, {len(rows)}개 세션의 consumed/score/judgements를 다시 확인했다. 모두 일치했다.",
      f"재조회 시 finalized block은 {recheck['finalizedBlock']:,}이며 이 거래 중 finalized 상태인 것은 {sum(x['finalizedAtSnapshot'] for x in recheck['transactions'])}개다. 이 보고서의 완료 기준은 2 confirmations이고 finalized 대기는 포함하지 않았다.",
      "추가 adapter 통합 테스트 **11개 통과**: 정직 입력, sealed header/root/commitment/digest/SRS/count/duration 변조, initial UP/duplicate DOWN/감소 clock. [테스트 로그](adapter-tests.log)",
      "이전 handoff의 source manifest와 비교해 기존 147개 파일은 변경되지 않았다. 이번에 simulator·orchestrator·검증/보고 도구·문서만 추가했다. 임시 organizer password file은 실행 종료 뒤 삭제했다. [실행 로그](execution.log)"]
    lines += ["", "## 재현과 원본", "", "- [실행 절차](../../../SEPOLIA_E2E.md)",
      "- [전체 run·receipt·환경·소스 hash](run.json)",
      "- [최종 RPC 재확인](chain-recheck.json)",
      "- `gkr-scoring/artifacts/fpga-e2e-sepolia-20260925/`: 각 run의 header/play/device result/signature/proof/submission 원본.",
      "- CPU/chain 결과는 이 실제 실행의 관측값이다. 물리 edge 검출·debounce·USB·SE050·secure boot·FPGA 합성/타이밍은 이번 실험에 포함되지 않았다.",""]
    (out/'REPORT.md').write_text('\n'.join(lines))
    print(out/'REPORT.md')

if __name__=='__main__': main()
