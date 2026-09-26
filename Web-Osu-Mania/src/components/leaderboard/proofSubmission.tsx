import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import type { BeatmapData } from "@/lib/beatmapParser";
import { chartFromBeatmap } from "@/lib/sui/chart";
import type { BridgeHardware } from "@/lib/hardware/useBridgeHardware";
import { suiDeployment } from "@/lib/sui/competition";
import { useGameStore } from "@/stores/gameStore";
import type { PlayResults } from "@/types";

type RelayPlan = {
  sessionId: string;
  registryId: string;
  packageId: string;
  traceBatches: string[][];
  proofGroups: string[][];
  steps: Array<{ arguments?: Array<{ value?: string | number | number[] }> }>;
  result?: { score: number };
};
type Job = { state: "proving" | "ready" | "failed" | "interrupted"; payload?: RelayPlan; error?: string };

function fromHex(value: string): Uint8Array {
  if (!/^0x(?:[\da-f]{2})*$/i.test(value)) throw new Error("Invalid hexadecimal proof data.");
  return Uint8Array.from(value.slice(2).match(/../g) || [], (byte) => Number.parseInt(byte, 16));
}

async function scoring(path: string, data?: object): Promise<Job> {
  const response = await fetch(`/api/scoring/${path}`, data ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  } : undefined);
  const value = await response.json() as Job;
  if (!response.ok) throw new Error(value.error || "Signed score proof is unavailable.");
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
        const sealed = await hardware.stopRecording();
        setMessage("Checking device signature and generating a Sui GKR proof…");
        const response = await scoring("submit", {
          sessionId: attempt.sessionId, resultHex: sealed.resultHex, traceHex: sealed.traceHex,
          chart: chartFromBeatmap(beatmap),
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
      }, (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
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
      arguments: [tx.object(suiDeployment.competitionId), tx.pure.address(attempt.sessionId)],
    });
    const result = await client.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
    const bytes = result.Transaction && result.commandResults?.[0]?.returnValues?.[0]?.bcs;
    if (!bytes) throw new Error("Could not check this score on Sui.");
    return bcs.bool().parse(bytes);
  }, [attempt?.sessionId, attempt?.player, client]);

  async function sendStage(tx: Transaction) {
    const result = await wallet.signAndExecuteTransaction({ transaction: tx });
    if (!result.Transaction) throw new Error("Sui trace upload was rejected. The play remains spent.");
    const confirmed = await client.waitForTransaction({ digest: result.Transaction.digest,
      include: { effects: true, objectTypes: true } });
    if (!confirmed.Transaction?.status.success) throw new Error("Sui trace upload failed. Recheck the signed proof.");
    return confirmed.Transaction;
  }

  async function submit() {
    const plan = job?.payload;
    if (!plan || !attempt || submitting || accepted || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      if (await confirmOnChain()) {
        setAccepted(true);
        setMessage("The signed score was already accepted on Sui.");
        return;
      }
      if (plan.sessionId !== attempt.sessionId || plan.registryId !== suiDeployment.registryId || plan.packageId !== suiDeployment.packageId) {
        throw new Error("Proof does not match this paid Sui session.");
      }
      const submitArgs = plan.steps.at(-1)?.arguments;
      if (!submitArgs || submitArgs.length !== 10) throw new Error("Scoring server returned an invalid on-chain submission plan.");
      if (account?.address !== attempt.player) throw new Error("Reconnect the wallet that played this run to submit its score.");
      const tx = new Transaction();
      const traceSize = plan.traceBatches.reduce((total, batch) =>
        total + batch.reduce((bytes, chunk) => bytes + (chunk.length - 2) / 2, 0), 0);
      const uploadKey = `sui-trace-upload:${attempt.sessionId}`;
      let trace;
      if (traceSize > 50_000) {
        let saved: { id: string; nextBatch: number } | undefined;
        try {
          const value = localStorage.getItem(uploadKey);
          if (value) saved = JSON.parse(value);
        } catch { /* The prover retains the completed signed capture. */ }
        if (saved && (!/^0x[0-9a-fA-F]{64}$/.test(saved.id) || !Number.isInteger(saved.nextBatch) ||
            saved.nextBatch < 0 || saved.nextBatch > plan.traceBatches.length)) saved = undefined;
        if (saved) {
          try {
            const object = await client.getObject({ objectId: saved.id });
            if (!object.object?.type.endsWith("::registry::TraceUpload")) saved = undefined;
          } catch { saved = undefined; }
        }
        if (!saved) {
          const init = new Transaction();
          const upload = init.moveCall({ target: `${suiDeployment.packageId}::registry::new_trace_upload`,
            arguments: [init.object(attempt.sessionId)] });
          const first = Math.min(4, plan.traceBatches.length);
          for (const chunks of plan.traceBatches.slice(0, first)) {
            init.moveCall({ target: `${suiDeployment.packageId}::registry::append_trace`,
              arguments: [upload, init.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(chunks.map(fromHex)))] });
          }
          init.transferObjects([upload], attempt.player);
          setMessage("Uploading signed inputs to Sui…");
          const uploaded = await sendStage(init);
          const id = uploaded.effects?.changedObjects.find((row) => row.idOperation === "Created" &&
            uploaded.objectTypes?.[row.objectId]?.endsWith("::registry::TraceUpload"))?.objectId;
          if (!id) throw new Error("Sui did not return the staged trace object.");
          saved = { id, nextBatch: first };
          try { localStorage.setItem(uploadKey, JSON.stringify(saved)); } catch { /* Optional checkpoint. */ }
        }
        for (let index = saved.nextBatch; index < plan.traceBatches.length; index += 4) {
          const part = new Transaction();
          for (const chunks of plan.traceBatches.slice(index, index + 4)) {
            part.moveCall({ target: `${suiDeployment.packageId}::registry::append_trace`,
              arguments: [part.object(saved.id), part.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(chunks.map(fromHex)))] });
          }
          setMessage(`Uploading signed inputs ${Math.min(index + 4, plan.traceBatches.length)}/${plan.traceBatches.length}…`);
          await sendStage(part);
          saved.nextBatch = Math.min(index + 4, plan.traceBatches.length);
          try { localStorage.setItem(uploadKey, JSON.stringify(saved)); } catch { /* Optional checkpoint. */ }
        }
        trace = tx.object(saved.id);
      } else {
        trace = tx.moveCall({ target: `${suiDeployment.packageId}::registry::new_trace_upload`,
          arguments: [tx.object(attempt.sessionId)] });
        for (const chunks of plan.traceBatches) {
          tx.moveCall({ target: `${suiDeployment.packageId}::registry::append_trace`,
            arguments: [trace, tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(chunks.map(fromHex)))] });
        }
      }
      const items = bcs.vector(bcs.vector(bcs.u8()));
      const proof = tx.makeMoveVec({
        type: "vector<vector<u8>>",
        elements: plan.proofGroups.map((group) => tx.pure(items.serialize(group.map(fromHex)))),
      });
      tx.moveCall({
        target: `${suiDeployment.packageId}::registry::submit_hardware`,
        arguments: [tx.object(suiDeployment.registryId), tx.object(attempt.sessionId), trace,
          tx.pure.u64(String(submitArgs[3].value)), tx.pure.vector("u8", fromHex(String(submitArgs[4].value))),
          tx.pure.vector("u64", submitArgs[5].value as number[]),
          tx.pure.vector("u64", submitArgs[6].value as number[]), proof,
          tx.pure.vector("u8", fromHex(String(submitArgs[8].value))), tx.object.clock()],
      });
      tx.moveCall({
        target: `${suiDeployment.packageId}::competition::record_score`,
        typeArguments: [suiDeployment.usdcType],
        arguments: [tx.object(suiDeployment.competitionId), tx.object(attempt.sessionId), tx.object.clock()],
      });
      setMessage("Confirm the signed score transaction in your Sui wallet…");
      const sent = await wallet.signAndExecuteTransaction({ transaction: tx });
      if (!sent.Transaction) throw new Error("Score transaction was rejected. Recheck this proof without consuming another play.");
      const confirmed = await client.waitForTransaction({ digest: sent.Transaction.digest, include: { events: true } });
      if (!confirmed.Transaction?.status.success || !confirmed.Transaction.events?.some((event) =>
        event.eventType.endsWith("::competition::PaidScoreRecorded") &&
        (event.json as { session?: string }).session === attempt.sessionId)) {
        throw new Error("No accepted Sui score was recorded for this session. Recheck before resubmitting.");
      }
      setAccepted(true);
      setMessage(`Bridge score ${plan.result?.score?.toLocaleString() ?? ""} accepted on Sui.`);
      try { localStorage.removeItem(`sui-trace-upload:${attempt.sessionId}`); } catch { /* Optional checkpoint. */ }
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
