import { useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { competitionChain } from "@/lib/walletConfig";
import { acceptedScore } from "@/lib/leaderboard/receipts";
import type { BeatmapData } from "@/lib/beatmapParser";
import type { PlayResults } from "@/types";
import { bridgeRequest, BridgeError, type ProofJob, type PaidAttempt } from "@/lib/leaderboard/bridge";
import { leaderboardAbi, leaderboardAddress } from "@/lib/leaderboard/contracts";
import { useGameStore } from "@/stores/gameStore";
import { Button } from "@/components/ui/button";

export type ProofPayload = { replay: NonNullable<PlayResults["replayData"]>; timing: { chartDelayMs: number }; webBeatmapHash: string };
export default function ProofSubmission({ results, beatmap, savedAttempt, savedPayload }: {
  results?: PlayResults; beatmap?: BeatmapData; savedAttempt?: PaidAttempt; savedPayload?: ProofPayload;
}) {
  const activeAttempt = useGameStore.use.paidAttempt();
  const attempt = savedAttempt || activeAttempt;
  const payload = savedPayload || (results?.replayData && beatmap ? {
    replay: results.replayData, timing: { chartDelayMs: beatmap.delay }, webBeatmapHash: beatmap.sourceHash,
  } : undefined);
  const client = usePublicClient({ chainId: competitionChain.id });
  const [message, setMessage] = useState("Ready to prove this paid attempt.");
  const [job, setJob] = useState<ProofJob>();
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [terminalFailure, setTerminalFailure] = useState(false);
  const [retryableFailure, setRetryableFailure] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (attempt && payload && !results?.viewingReplay) {
      try { localStorage.setItem(`paid-proof:${attempt.sessionId}`, JSON.stringify(payload)); }
      catch { setMessage("Browser storage is full. Keep this page open until proof submission completes."); }
    }
  }, [attempt?.sessionId, results, beatmap, savedPayload]);

  async function submit() {
    if (!attempt || !client || !leaderboardAddress || locked.current) return;
    locked.current = true; setBusy(true);
    try {
      if (results?.viewingReplay || !payload || payload.replay.version !== 2) throw new Error("A live recorded attempt is required.");
      const key = `paid-proof:${attempt.sessionId}`;
      // Preserve evidence for retry if the connection is lost or the player navigates away.
      try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* Submission can proceed without persistence. */ }
      const readAccepted = async () => {
        const entry = await client.readContract({ address: leaderboardAddress!, abi: leaderboardAbi, functionName: "entries", args: [attempt.sessionId] });
        if (entry[0] !== attempt.chartHash || entry[1] !== BigInt(attempt.dayId) || entry[3].toLowerCase() !== attempt.player.toLowerCase()) {
          throw new Error("Saved attempt does not match the on-chain paid session.");
        }
        return entry[4];
      };
      const markExistingAccepted = () => {
        setAccepted(true); setMessage("This paid session already has an accepted on-chain score.");
        localStorage.removeItem(key);
      };
      if (await readAccepted()) { markExistingAccepted(); return; }
      let jobId = localStorage.getItem(`paid-job:${attempt.sessionId}`);
      if (retryableFailure) {
        const retried = await bridgeRequest<{ jobId: string }>(`/sessions/${attempt.sessionId}/proof`, { ...payload, retry: true });
        if (!retried.jobId) throw new Error("Prover returned no retry job identifier.");
        jobId = retried.jobId;
        localStorage.setItem(`paid-job:${attempt.sessionId}`, jobId);
        setRetryableFailure(false);
      }
      if (!jobId) {
        const block = await client.getBlock();
        if (Number(block.timestamp) >= (attempt.dayId + 1) * 86400) throw new Error("The UTC deadline passed before proof submission. Check the round for payout or refund eligibility.");
        setMessage("Sending captured gameplay for proof generation…");
        await bridgeRequest(`/sessions/${attempt.sessionId}/start`, attempt);
        const started = await bridgeRequest<{ jobId: string }>(`/sessions/${attempt.sessionId}/proof`, payload);
        if (!started.jobId) throw new Error("Prover returned no job identifier.");
        jobId = started.jobId;
        localStorage.setItem(`paid-job:${attempt.sessionId}`, jobId);
      }
      let recovered = false;
      while (alive.current) {
        let current: ProofJob;
        try { current = await bridgeRequest<ProofJob>(`/jobs/${encodeURIComponent(jobId)}`); }
        catch (error) {
          if (!(error instanceof BridgeError) || error.status !== 404 || recovered) throw error;
          if (await readAccepted()) { markExistingAccepted(); return; }
          // The bridge restarted before persisting a job. Resume only this same paid session.
          recovered = true;
          await bridgeRequest(`/sessions/${attempt.sessionId}/start`, attempt);
          const resumed = await bridgeRequest<{ jobId: string }>(`/sessions/${attempt.sessionId}/proof`, payload);
          if (!resumed.jobId) throw new Error("Prover returned no recovery job identifier.");
          jobId = resumed.jobId;
          localStorage.setItem(`paid-job:${attempt.sessionId}`, jobId);
          continue;
        }
        if (!alive.current) return;
        setJob(current); setMessage(current.message || current.status);
        if (current.status === "failed") { setTerminalFailure(!current.retryable); setRetryableFailure(!!current.retryable); throw new Error(current.message || "Proof generation or submission failed."); }
        if (current.status === "confirmed") {
          if (!current.transactionHash) throw new Error("Prover claimed confirmation without a transaction hash.");
          setMessage("Checking proof transaction and accepted score directly on chain…");
          const receipt = await client.waitForTransactionReceipt({ hash: current.transactionHash, confirmations: 2 });
          const score = acceptedScore(receipt, leaderboardAddress, { chartHash: attempt.chartHash,
            sessionId: attempt.sessionId, player: attempt.player, dayId: BigInt(attempt.dayId) });
          const entry = await client.readContract({ address: leaderboardAddress!, abi: leaderboardAbi, functionName: "entries", args: [attempt.sessionId] });
          if (!entry[4] || entry[0] !== attempt.chartHash || entry[1] !== BigInt(attempt.dayId) || entry[3].toLowerCase() !== attempt.player.toLowerCase()) throw new Error("No accepted on-chain score for this paid session.");
          setAccepted(true); setMessage(`Verified score accepted on-chain: ${score}. The displayed gameplay score can use different scoring rules.`);
          localStorage.removeItem(key);
          return;
        }
        if (!["queued", "capturing", "proving", "submitting"].includes(current.status)) throw new Error("Unknown prover job status.");
        if (Date.now() / 1000 >= (attempt.dayId + 1) * 86400) {
          throw new Error("The UTC deadline has passed. Recheck the job to see whether its transaction was accepted before midnight.");
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : String(error));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  if (!attempt) return null;
  return <section className="mx-auto my-4 max-w-3xl space-y-3 rounded border p-4" aria-label="Paid score proof">
    <h2 className="font-semibold">Daily competition proof</h2>
    <p className="break-all">Session: {attempt.sessionId}</p>
    <p>Capture: {attempt.captureMode === "hardware" ? "signed hardware" : "software-signer demo (not physical hardware)"}</p>
    <p role="status">{message}</p>
    {!accepted && <Button disabled={busy || terminalFailure} onClick={() => void submit()}>{busy ? "Proof in progress…" : retryableFailure ? "Retry proof" : "Submit / recheck proof"}</Button>}
    {terminalFailure && <p>This job failed. Check its transaction or contact the operator before making another paid attempt.</p>}
    {job?.transactionHash && competitionChain.blockExplorers && <a className="block underline" href={`${competitionChain.blockExplorers?.default.url}/tx/${job.transactionHash}`} target="_blank" rel="noreferrer">View proof transaction</a>}
    <p>Proof acceptance must occur before midnight UTC. Each new attempt requires a new entry.</p>
  </section>;
}
