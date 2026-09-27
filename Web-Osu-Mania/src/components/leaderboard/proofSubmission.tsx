import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import type { BeatmapData } from "@/lib/beatmapParser";
import { chartFromBeatmap, chartHash } from "@/lib/sui/chart";
import type { BridgeHardware } from "@/lib/hardware/useBridgeHardware";
import { configured, difficultyCode, suiDeployment } from "@/lib/sui/competition";
import { useGameStore } from "@/stores/gameStore";
import type { PlayResults } from "@/types";

type RelayPlan = {
  kind: "sui-programmable-transaction";
  mode: "committed";
  sessionId: string;
  registryId: string;
  packageId: string;
  proofGroups: string[][];
  n: string;
  root: string;
  traceCommitment: string;
  duration: string;
  laneBits: number[];
  counts: number[];
  signature: string;
  result: { score: number };
};
type Job = { state: "proving" | "ready" | "failed" | "interrupted"; payload?: RelayPlan; error?: string };

function fromHex(value: string): Uint8Array {
  if (!/^0x(?:[\da-f]{2})*$/i.test(value)) throw new Error("Invalid hexadecimal proof data.");
  return Uint8Array.from(value.slice(2).match(/../g) || [], (byte) => Number.parseInt(byte, 16));
}
function committedPlan(value: unknown): RelayPlan {
  const plan = value as RelayPlan & { steps?: unknown; traceBatches?: unknown };
  const hexBytes = (data: unknown, length: number) =>
    typeof data === "string" && new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(data);
  const u64 = (data: unknown) => typeof data === "string" && /^(0|[1-9]\d*)$/.test(data) && BigInt(data) <= 18446744073709551615n;
  const words = (data: unknown, length: number) => Array.isArray(data) && data.length === length &&
    data.every((word) => Number.isSafeInteger(word) && word >= 0);
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.kind !== "sui-programmable-transaction" ||
      plan.mode !== "committed" || "steps" in plan || "traceBatches" in plan ||
      !hexBytes(plan.root, 32) || !hexBytes(plan.traceCommitment, 48) || !hexBytes(plan.signature, 65) ||
      !u64(plan.n) || BigInt(plan.n) > 50000n || !u64(plan.duration) ||
      !words(plan.laneBits, 4) || !words(plan.counts, 5) ||
      !Array.isArray(plan.proofGroups) || plan.proofGroups.length === 0 ||
      !plan.proofGroups.every((group) => Array.isArray(group) && group.every((item) =>
        typeof item === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(item))) ||
      !plan.result || !Number.isSafeInteger(plan.result.score) || plan.result.score < 0 ||
      typeof plan.sessionId !== "string" || typeof plan.registryId !== "string" || typeof plan.packageId !== "string") {
    throw new Error("Scoring server returned an invalid Mode-B committed proof; legacy trace plans cannot be submitted.");
  }
  return plan;
}

async function scoring(path: string, data?: object): Promise<Job> {
  const response = await fetch(`/api/scoring/${path}`, data ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  } : undefined);
  const value = await response.json() as Job;
  if (!response.ok) throw new Error(value.error || "Signed score proof is unavailable.");
  if (value.state === "ready") value.payload = committedPlan(value.payload);
  return value;
}

export default function ProofSubmission({ results, beatmap, hardware }: {
  results: PlayResults;
  beatmap: BeatmapData;
  hardware: BridgeHardware;
}) {
  const attempt = useGameStore.use.paidAttempt();
  const wallet = useDAppKit();
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const [job, setJob] = useState<Job | null>(null);
  const [message, setMessage] = useState("Stopping the signed hardware capture…");
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const started = useRef(false);
  const submitLock = useRef(false);

  useEffect(() => {
    if (!attempt || started.current) return;
    started.current = true;
    if (results.failed || results.viewingReplay) {
      setMessage("The run did not finish. This play was used; no score can be submitted.");
      void hardware.abortRecording().catch(() => {});
      return;
    }
    void (async () => {
      try {
        const chart = chartFromBeatmap(beatmap);
        // scoring-core requires the signed device duration to include the final
        // note plus its full 136.5 ms miss window; browser finish time may differ.
        const lastNoteEndUs = chart.notes.reduce((latest, note) => Math.max(latest, note.end_us), 0);
        setMessage("Waiting for the Bridge's final hit window…");
        const sealed = await hardware.stopRecording(BigInt(lastNoteEndUs + 136_500));
        setMessage("Checking device signature and generating a Sui GKR proof…");
        const response = await scoring("submit", {
          sessionId: attempt.sessionId, resultHex: sealed.resultHex, traceHex: sealed.traceHex,
          chart,
        });
        if (response.state === "ready") setJob({ state: "ready", payload: response.payload });
        else setJob({ state: "proving" });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [attempt?.sessionId, beatmap, results, hardware.stopRecording, hardware.abortRecording]);

  useEffect(() => {
    if (!attempt || job?.state !== "proving") return;
    const timer = setInterval(() => {
      void scoring(`jobs/${attempt.sessionId}`).then((value: Job) => {
        setJob(value);
        if (value.state === "failed") setMessage(value.error || "Signed proof failed. This run cannot resume.");
        if (value.state === "interrupted") setMessage("Proof generation was interrupted. Recheck the saved capture with the operator.");
        if (value.state === "ready") setMessage("Hardware proof is ready. Submit it to Sui to register your score.");
      }, (error: unknown) => {
        setJob({ state: "failed" });
        setMessage(error instanceof Error ? error.message : String(error));
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [attempt?.sessionId, job?.state]);

  const confirmOnChain = useCallback(async () => {
    if (!attempt) return false;
    const tx = new Transaction();
    tx.setSender(attempt.player);
    tx.moveCall({
      target: `${suiDeployment.packageId}::competition::attempt_recorded`,
      typeArguments: [suiDeployment.usdcType],
      arguments: [tx.object(attempt.challengeId), tx.pure.address(attempt.sessionId)],
    });
    const result = await client.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
    const bytes = result.Transaction && result.commandResults?.[0]?.returnValues?.[0]?.bcs;
    if (!bytes) throw new Error("Could not check this score on Sui.");
    return bcs.bool().parse(bytes);
  }, [attempt?.sessionId, attempt?.player, attempt?.challengeId, client]);

  async function assertOpenScoreWindow() {
    if (!attempt || !Number.isSafeInteger(attempt.scoreDeadlineMs)) throw new Error("Paid session has no valid Sui score deadline.");
    const [{ object: challenge }, { object: clock }] = await Promise.all([
      client.getObject({ objectId: attempt.challengeId, include: { json: true } }),
      client.getObject({ objectId: "0x6", include: { json: true } }),
    ]);
    const chainDeadline = challenge?.json?.score_deadline_ms;
    const chainTime = clock?.json?.timestamp_ms;
    const validTime = (value: unknown): value is number | string =>
      typeof value === "number" ? Number.isSafeInteger(value) && value >= 0 :
        typeof value === "string" && /^\d+$/.test(value);
    if (challenge?.type !== `${suiDeployment.packageId}::competition::Challenge<${suiDeployment.usdcType}>` ||
        !validTime(chainDeadline) || !validTime(chainTime) ||
        BigInt(chainDeadline) !== BigInt(attempt.scoreDeadlineMs)) {
      throw new Error("Paid session deadline does not match this Sui challenge.");
    }
    if (BigInt(chainTime) >= BigInt(chainDeadline)) throw new Error("The six-hour Sui score window closed before proof submission.");
  }

  async function submit() {
    const plan = job?.payload;
    if (!plan || !attempt || submitting || accepted || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      if (!configured || attempt.challengeId !== suiDeployment.challengeId ||
          beatmap.sourceHash !== attempt.webBeatmapHash ||
          (await chartHash(chartFromBeatmap(beatmap))).toLowerCase() !== suiDeployment.charts[attempt.difficulty].toLowerCase()) {
        throw new Error("This signed run does not match its selected challenge chart.");
      }
      if (await confirmOnChain()) {
        setAccepted(true);
        setMessage("The signed score was already accepted on Sui.");
        return;
      }
      await assertOpenScoreWindow();
      if (plan.sessionId !== attempt.sessionId || plan.registryId !== suiDeployment.registryId || plan.packageId !== suiDeployment.packageId) {
        throw new Error("Proof does not match this paid Sui session.");
      }
      if (account?.address !== attempt.player) throw new Error("Reconnect the wallet that played this run to submit its score.");
      const tx = new Transaction();
      const items = bcs.vector(bcs.vector(bcs.u8()));
      const proof = tx.makeMoveVec({
        type: "vector<vector<u8>>",
        elements: plan.proofGroups.map((group) => tx.pure(items.serialize(group.map(fromHex)))),
      });
      tx.moveCall({
        target: `${suiDeployment.packageId}::registry::submit_committed`,
        arguments: [tx.object(suiDeployment.registryId), tx.object(attempt.sessionId),
          tx.pure.u64(plan.n), tx.pure.vector("u8", fromHex(plan.root)),
          tx.pure.vector("u8", fromHex(plan.traceCommitment)), tx.pure.u64(plan.duration),
          tx.pure.vector("u64", plan.laneBits), tx.pure.vector("u64", plan.counts), proof,
          tx.pure.vector("u8", fromHex(plan.signature)), tx.object.clock()],
      });
      tx.moveCall({
        target: `${suiDeployment.packageId}::competition::record_score`,
        typeArguments: [suiDeployment.usdcType],
        arguments: [tx.object(attempt.challengeId), tx.object(attempt.sessionId), tx.object.clock()],
      });
      await assertOpenScoreWindow();
      setMessage("Confirm the signed score transaction in your Sui wallet…");
      const sent = await wallet.signAndExecuteTransaction({ transaction: tx });
      if (!sent.Transaction) throw new Error("Score transaction was rejected. Recheck this proof without consuming another play.");
      const confirmed = await client.waitForTransaction({ digest: sent.Transaction.digest, include: { events: true } });
      if (!confirmed.Transaction?.status.success || !confirmed.Transaction.events?.some((event) => {
        const value = event.json;
        return event.eventType.endsWith("::competition::PaidScoreRecorded") &&
          value && typeof value === "object" && "session" in value && "challenge" in value && "difficulty" in value && "wallet" in value &&
          value.session === attempt.sessionId && value.challenge === attempt.challengeId && value.wallet === attempt.player &&
          Number(value.difficulty) === difficultyCode(attempt.difficulty);
      })) throw new Error("No accepted Sui score was recorded for this selected challenge and difficulty. Recheck before resubmitting.");
      setAccepted(true);
      setMessage(`Bridge score ${plan.result.score.toLocaleString()} accepted on Sui.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
      submitLock.current = false;
    }
  }

  if (!attempt) return null;
  return <section className="arena-proof" aria-label="Signed score proof">
    <h2>Score proof</h2>
    <p role="status">{message}</p>
    {job?.payload?.result && <p>Bridge score: {job.payload.result.score.toLocaleString()}</p>}
    <p>Only the Bridge score enters the leaderboard.</p>
    {job?.state === "ready" && !accepted && <button className="arena-primary" disabled={submitting} onClick={() => void submit()}>
      {submitting ? "Submitting…" : "Submit score"}
    </button>}
    {job?.state === "interrupted" && <button className="arena-secondary" disabled={submitting} onClick={() => {
      if (!attempt) return;
      setSubmitting(true);
      void fetch(`/api/scoring/jobs/${attempt.sessionId}/retry`, { method: "POST" })
        .then(async (response) => {
          const value = await response.json() as Job;
          if (!response.ok) throw new Error(value.error || "Could not resume proof generation.");
          setJob(value);
          setMessage("Rechecking the completed signed capture…");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
        .finally(() => setSubmitting(false));
    }}>Recheck completed proof</button>}
  </section>;
}
