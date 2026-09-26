import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaidAttempt } from "@/lib/leaderboard/scoring";
import ProofSubmission, { type ProofPayload } from "./proofSubmission";
export default function RecoveredAttempts({ chartHash }: { chartHash: string }) {
  const { address } = useAccount();
  const [saved, setSaved] = useState<{ attempt: PaidAttempt; payload?: ProofPayload }[]>([]);
  useEffect(() => {
    const found: typeof saved = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("paid-entry:")) continue;
      try {
        const attempt = JSON.parse(localStorage.getItem(key)!) as PaidAttempt;
        if (attempt.chartHash !== chartHash || attempt.player.toLowerCase() !== address?.toLowerCase()) continue;
        const payload = localStorage.getItem(`paid-proof:${attempt.sessionId}`);
        found.push({ attempt, payload: payload ? JSON.parse(payload) : undefined });
      } catch { /* Skip malformed local state; it is never authoritative. */ }
    }
    setSaved(found.reverse());
  }, [address, chartHash]);
  if (!saved.length) return null;
  return <details><summary>Your saved paid attempts ({saved.length})</summary>
    {saved.map(({ attempt, payload }) => <div key={attempt.sessionId} className="my-2 border-t pt-2">
      {payload ? <ProofSubmission savedAttempt={attempt} savedPayload={payload} /> : <>
        <p className="break-all">Session {attempt.sessionId}</p>
        <p>No pending browser replay. Check the daily record for accepted scores. Unfinished entries fund the winner; if the day has no accepted scores, use the refund button after midnight.</p>
      </>}
    </div>)}
  </details>;
}
