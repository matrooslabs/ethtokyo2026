import { submitAndConfirm } from "@/lib/leaderboard/walletSubmission";
import { useState, useRef } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { competitionChain } from "@/lib/walletConfig";
import { acceptedScore } from "@/lib/leaderboard/receipts";
import type { BeatmapData } from "@/lib/beatmapParser";
import type { PlayResults } from "@/types";
import {
  scoringRequest,
  type ProofJob,
  type PaidAttempt,
} from "@/lib/leaderboard/scoring";
import {
  leaderboardAbi,
  leaderboardAddress,
  registryAbi,
  registryAddress,
} from "@/lib/leaderboard/contracts";
import {
  saved,
  save,
  finishCapture,
  validateCapture,
  type Capture,
} from "@/lib/leaderboard/capture";
import { useGameStore } from "@/stores/gameStore";
import { Button } from "@/components/ui/button";
export type ProofPayload = Capture;
export default function ProofSubmission({
  savedAttempt,
}: {
  results?: PlayResults;
  beatmap?: BeatmapData;
  savedAttempt?: PaidAttempt;
  savedPayload?: ProofPayload;
}) {
  const active = useGameStore.use.paidAttempt(),
    attempt = savedAttempt || active;
  const client = usePublicClient({ chainId: competitionChain.id }),
    account = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [message, setMessage] = useState(
    "Original hardware capture awaiting verification.",
  );
  const [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState(false);
  const lock = useRef(false);
  async function submit() {
    if (!attempt || !client || !leaderboardAddress || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (
        attempt.chainId !== competitionChain.id ||
        attempt.registry.toLowerCase() !== registryAddress?.toLowerCase()
      )
        throw new Error(
          "Saved deployment differs from configured Mode B registry. Use the original deployment for lookup.",
        );
      let r = await saved(attempt);
      if (!r)
        throw new Error(
          "No durable hardware attempt. Legacy Mode A records cannot be converted.",
        );
      const readAccepted = async () => {
        const e = await client.readContract({
          address: leaderboardAddress!,
          abi: leaderboardAbi,
          functionName: "entries",
          args: [attempt.sessionId],
        });
        const s = await client.readContract({
          address: attempt.registry,
          abi: registryAbi,
          functionName: "getSession",
          args: [attempt.sessionId],
        });
        if (
          e[0] !== attempt.chartHash ||
          e[1] !== BigInt(attempt.dayId) ||
          e[3].toLowerCase() !== attempt.player.toLowerCase() ||
          s.mode !== 2
        )
          throw new Error("Saved attempt differs from paid entry");
        return e[4] && s.consumed;
      };
      if (await readAccepted()) {
        setAccepted(true);
        setMessage("Session already accepted on-chain.");
        return;
      }
      if (!r.capture) {
        setMessage("Retrieving original finalized board data…");
        r = await finishCapture(attempt);
      }
      const checked = await validateCapture(r.capture!, r);
      if (!r.proof && !r.transactionHash) {
        await scoringRequest(`/sessions/${attempt.sessionId}/start`, attempt);
        const { jobId } = await scoringRequest<{ jobId: string }>(
          `/sessions/${attempt.sessionId}/proof`,
          r.capture,
        );
        for (;;) {
          const job = await scoringRequest<ProofJob>(
            `/jobs/${encodeURIComponent(jobId)}`,
          );
          if (job.sessionId !== attempt.sessionId)
            throw new Error("Prover returned another session");
          if (job.status === "failed")
            throw new Error(
              job.message || "Proof failed; retained capture can be retried",
            );
          if (job.status === "ready") {
            if (!job.result) throw new Error("Missing proof result");
            r.proof = job.result;
            await save(r);
            break;
          }
          if (!["queued", "proving"].includes(job.status))
            throw new Error("Invalid prover state");
          setMessage(
            "Awaiting SRS commitment verification and proof generation…",
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
      const record = r;
      const score = await submitAndConfirm(record, {
        send: async () => {
          const p = record.proof!,
            sub = p.submission;
          if (
            p.chainId !== attempt.chainId ||
            p.registry.toLowerCase() !== attempt.registry.toLowerCase() ||
            p.sessionId !== attempt.sessionId ||
            p.srsId !== record.setup!.hardwareSrs.srsId ||
            p.sessionDigest !== checked.digest ||
            sub.sessionId !== attempt.sessionId ||
            sub.eventCount !== checked.n ||
            BigInt(sub.duration) !== checked.duration ||
            sub.root !== checked.root ||
            sub.signature !== checked.signature ||
            sub.commitment.some(
              (c, i) => BigInt(c) !== BigInt(checked.commitment[i]),
            )
          )
            throw new Error(
              "Proof submission differs from immutable signed capture",
            );
          if (
            account.chainId !== attempt.chainId ||
            account.address?.toLowerCase() !== attempt.player.toLowerCase()
          )
            throw new Error(
              "Connect the player wallet on the paid session network. Proof is saved.",
            );
          const args = [
            attempt.sessionId,
            sub.eventCount,
            sub.root,
            sub.commitment.map(BigInt) as [bigint, bigint],
            {
              duration: BigInt(sub.duration),
              laneBits: sub.laneBits,
              counts: sub.counts,
            },
            sub.proof.map(BigInt),
            sub.signature,
          ] as const;
          setMessage(
            "Verified proof ready. Confirm submission gas in your wallet.",
          );
          const { request } = await client.simulateContract({
            address: attempt.registry,
            abi: registryAbi,
            functionName: "submitCommitted",
            args,
            account: account.address,
          });
          return writeContractAsync({ ...request, chainId: attempt.chainId });
        },
        persist: save,
        wait: (hash, replaced) => {
          setMessage("Waiting for proof transaction confirmations…");
          return client.waitForTransactionReceipt({
            hash,
            confirmations: 2,
            onReplaced: (replacement) => replaced(replacement.transaction.hash),
          });
        },
        accepted: readAccepted,
        score: (receipt) =>
          acceptedScore(receipt, leaderboardAddress!, {
            chartHash: attempt.chartHash,
            sessionId: attempt.sessionId,
            player: attempt.player,
            dayId: BigInt(attempt.dayId),
          }),
      });
      setAccepted(true);
      setMessage(`Score ${score} accepted on-chain.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!attempt) return null;
  return (
    <section className="mx-auto my-4 max-w-3xl space-y-3 rounded border p-4">
      <p className="break-all">Hardware session {attempt.sessionId}</p>
      <p role="status">{message}</p>
      {!accepted && (
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? "Verifying / submitting…" : "Recover / prove / submit"}
        </Button>
      )}
      <p>
        The player wallet pays submission gas. Captures and proofs are retained
        for retry.
      </p>
    </section>
  );
}
