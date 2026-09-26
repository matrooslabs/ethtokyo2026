import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { allSaved, type Saved } from "@/lib/leaderboard/capture";
import ProofSubmission from "./proofSubmission";
export default function RecoveredAttempts({
  chartHash,
}: {
  chartHash: string;
}) {
  const { address } = useAccount();
  const [legacy, setLegacy] = useState<{sessionId:string;entryTxHash:string}[]>([]);
  const [records, setRecords] = useState<Saved[]>([]);
  useEffect(() => {
    const old: {sessionId:string;entryTxHash:string}[] = [];
    for (let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if (!key?.startsWith('paid-entry:')) continue;
      try {
        const r=JSON.parse(localStorage.getItem(key)!);
        if (!r.registry && r.chartHash===chartHash && r.player?.toLowerCase()===address?.toLowerCase()) old.push(r);
      } catch { /* Historical records are lookup-only. */ }
    }
    setLegacy(old);
    void allSaved().then((rows) =>
      setRecords(
        rows.filter(
          (r) =>
            r.attempt.chartHash === chartHash &&
            r.attempt.player.toLowerCase() === address?.toLowerCase(),
        ),
      ),
    );
  }, [address, chartHash]);
  if (!records.length && !legacy.length) return null;
  return (
    <details>
      <summary>Saved hardware attempts ({records.length})</summary>
      {legacy.map(r => <div key={r.sessionId} className="my-2 break-all">
        <p>Legacy session: {r.sessionId}</p><p>Entry transaction: {r.entryTxHash}</p>
        <p>Use its original deployment for settlement and transaction lookup. This record is not a Mode B attempt.</p>
      </div>)}
      {records.map((r) => (
        <ProofSubmission
          key={`${r.attempt.chainId}:${r.attempt.registry}:${r.attempt.sessionId}`}
          savedAttempt={r.attempt}
        />
      ))}
    </details>
  );
}
