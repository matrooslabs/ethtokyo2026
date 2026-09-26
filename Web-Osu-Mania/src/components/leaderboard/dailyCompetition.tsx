import { paidSession } from "@/lib/leaderboard/receipts";
import RecoveredAttempts from "./recoveredAttempts";
import { walletConnectConfigured, competitionChain } from "@/lib/walletConfig";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { erc20Abi, formatUnits, zeroAddress, type Hex } from "viem";
import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";
import { leaderboardAbi, leaderboardAddress, indexerUrl } from "@/lib/leaderboard/contracts";
import { getChartSetup, getChartForDisplay, type PaidAttempt } from "@/lib/leaderboard/bridge";
import { canEnter, dateDay, dayOf, endOf, ENTRY_FEE, utcDate } from "@/lib/leaderboard/rules";
import { useGameStore } from "@/stores/gameStore";
import { Button } from "@/components/ui/button";

type Ranking = { rank: number; player: string; score: string };
export default function DailyCompetition({ beatmap, beatmapSet, stopPreview }: {
  beatmap: Beatmap; beatmapSet: BeatmapSet; stopPreview: () => void;
}) {
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  const client = usePublicClient({ chainId: competitionChain.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [selectedDate, setSelectedDate] = useState("");
  const [wallNow, setNow] = useState(0);
  const clockQuery = useQuery({ queryKey: ["competition-clock", competitionChain.id], enabled: !!client,
    queryFn: async () => ({ timestamp: Number((await client!.getBlock()).timestamp), observedAt: Date.now() / 1000 }),
    refetchInterval: 12000, retry: false });
  const now = clockQuery.data && wallNow ? clockQuery.data.timestamp + Math.max(0, wallNow - clockQuery.data.observedAt) : wallNow;
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState<Hex>();
  const [demoAcknowledged, setDemoAcknowledged] = useState(false);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  const selectedDay = selectedDate ? dateDay(selectedDate) : dayOf(now);
  const chartQuery = useQuery({ queryKey: ["paid-chart", beatmap.sourceHash],
    queryFn: () => getChartForDisplay(beatmap.sourceHash!), enabled: !!beatmap.sourceHash && !!leaderboardAddress,
    retry: false, refetchInterval: 30000 });
  const chart = chartQuery.data;
  const roundQuery = useQuery({ queryKey: ["daily-round", leaderboardAddress, chart?.chartHash, selectedDay, account.address],
    enabled: !!client && !!leaderboardAddress && !!chart && now > 0,
    queryFn: async () => {
      const block = await client!.getBlock();
      const base = { address: leaderboardAddress!, abi: leaderboardAbi, blockNumber: block.number };
      const [round, personal, refundable] = await Promise.all([
        client!.readContract({ ...base, functionName: "rounds", args: [chart!.chartHash, BigInt(selectedDay)] }),
        client!.readContract({ ...base, functionName: "records", args: [chart!.chartHash, BigInt(selectedDay), account.address || zeroAddress] }),
        client!.readContract({ ...base, functionName: "refundablePayments", args: [chart!.chartHash, BigInt(selectedDay), account.address || zeroAddress] }),
      ]);
      return { round, personal, refundable, timestamp: Number(block.timestamp) };
    }, refetchInterval: 12000, retry: false });
  const rankingsQuery = useQuery({ queryKey: ["daily-rankings", chart?.chartHash, selectedDay],
    enabled: !!indexerUrl && !!chart,
    queryFn: async () => {
      const responses = await Promise.all([
        fetch(`${indexerUrl}/charts/${chart!.chartHash}/days/${selectedDay}/rankings?limit=20`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${indexerUrl}/status`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (responses.some(response => !response.ok)) throw new Error("Rankings unavailable");
      const rankings = await responses[0].json() as { items: Ranking[] };
      const status = await responses[1].json() as { chainId: string; address: string; indexedBlock: string | null; lag: string | null; lastError: string | null };
      if (String(status.chainId) !== String(competitionChain.id) || status.address?.toLowerCase() !== leaderboardAddress?.toLowerCase()) {
        throw new Error("Indexer deployment mismatch");
      }
      return { items: rankings.items as Ranking[], status };
    }, refetchInterval: 15000, retry: false });

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage(""); setTxHash(undefined);
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { locked.current = false; setBusy(false); void roundQuery.refetch(); }
  }
  async function ensureWallet() {
    if (!account.address) { openConnectModal?.(); throw new Error("Connect a wallet, then try again."); }
    if (account.chainId !== competitionChain.id) await switchChainAsync({ chainId: competitionChain.id });
    return account.address;
  }
  async function confirmed(hash: Hex) {
    setTxHash(hash);
    const receipt = await client!.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (receipt.status !== "success") throw new Error("Transaction reverted. No paid game started.");
    return receipt;
  }
  async function enter() {
    const player = await ensureWallet();
    if (!client || !leaderboardAddress || !beatmap.sourceHash) throw new Error("Deployment unavailable.");
    // Refresh readiness and chain time before asking the player to spend tokens.
    const prepared = await getChartSetup(beatmap.sourceHash);
    if (!prepared.ready) throw new Error(prepared.reason || "Capture/prover is not ready.");
    if (prepared.captureMode === "software-demo" && !demoAcknowledged) throw new Error("Acknowledge the software-signer demo before entering.");
    const duration = Math.max(prepared.durationSeconds, beatmap.total_length) + 5;
    let block = await client.getBlock();
    if (!canEnter(Math.max(Number(block.timestamp), Date.now() / 1000), duration, prepared.provingBufferSeconds)) {
      throw new Error("Entry closed: there is not enough time to play and prove before midnight UTC.");
    }
    const token = await client.readContract({ address: leaderboardAddress, abi: leaderboardAbi, functionName: "token" });
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [player, leaderboardAddress] });
    if (allowance < ENTRY_FEE) {
      setMessage("Approve 1 USDC in your wallet, then wait for confirmation.");
      await confirmed(await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [leaderboardAddress, ENTRY_FEE], chainId: competitionChain.id, account: player }));
    }
    block = await client.getBlock();
    const timestamp = Math.max(Number(block.timestamp), Date.now() / 1000);
    if (!canEnter(timestamp, duration, prepared.provingBufferSeconds)) throw new Error("Entry closed while waiting for approval. No entry payment was made.");
    const day = dayOf(Number(block.timestamp));
    setMessage("Confirm the 1 USDC entry in your wallet. Gameplay starts after two confirmations.");
    const receipt = await confirmed(await writeContractAsync({ address: leaderboardAddress, abi: leaderboardAbi,
      functionName: "enter", args: [prepared.chartHash, player, prepared.device, BigInt(day)], chainId: competitionChain.id, account: player }));
    const sessionId = paidSession(receipt, leaderboardAddress, { chartHash: prepared.chartHash,
      player, payer: player, device: prepared.device, dayId: BigInt(day), amount: ENTRY_FEE });
    const attempt: PaidAttempt = { sessionId, entryTxHash: receipt.transactionHash, player,
      chartHash: prepared.chartHash, dayId: day, webBeatmapHash: beatmap.sourceHash, captureMode: prepared.captureMode };
    // Persist the receipt even if the prover/start subsequently fails; payment is already final.
    try { localStorage.setItem(`paid-entry:${attempt.sessionId}`, JSON.stringify(attempt)); }
    catch { /* Confirmed payment still starts play when browser storage is full. */ }
    stopPreview();
    useGameStore.getState().startPaidGame(beatmapSet, beatmap.id, attempt);
    setMessage(`Entry confirmed. Session ${attempt.sessionId}`);
  }
  async function settle(functionName: "claim" | "refund") {
    const player = await ensureWallet();
    if (!chart || !leaderboardAddress) throw new Error("Select a registered chart.");
    setMessage(`Confirm ${functionName} in your wallet.`);
    await confirmed(await writeContractAsync({ address: leaderboardAddress, abi: leaderboardAbi,
      functionName, args: [chart.chartHash, BigInt(selectedDay)], chainId: competitionChain.id, account: player }));
    setMessage(functionName === "claim" ? "Prize sent to the winning wallet." : "Entry fees refunded to your wallet.");
  }
  if (!leaderboardAddress) return <p className="px-2 text-sm text-muted-foreground">Practice available. Daily competition deployment is not configured.</p>;
  const data = roundQuery.data;
  const closed = data && data.timestamp >= endOf(selectedDay);
  const room = chart && canEnter(now, Math.max(chart.durationSeconds, beatmap.total_length) + 5, chart.provingBufferSeconds);
  return <section aria-label={`Daily competition for ${beatmap.version}`} className="my-2 space-y-3 rounded-lg border p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>Daily prize · {competitionChain.name}</strong>
      <label>UTC date <input aria-label="Competition UTC date" type="date" value={selectedDate || (now ? utcDate(dayOf(now)) : "")} onChange={event => setSelectedDate(event.target.value)} className="rounded border bg-background p-1" /></label>
    </div>
    <p>Scores must be accepted before {now ? new Date(endOf(selectedDay) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") : "midnight UTC"}. First accepted score wins ties.</p>
    {chartQuery.isError && <p role="alert">{chartQuery.error.message}</p>}
    {chart && !chart.ready && <p>{chart.reason || "Paid play unavailable while capture/prover is offline."}</p>}
    {chart?.captureMode === "software-demo" && <label className="flex gap-2 text-amber-400"><input type="checkbox" checked={demoAcknowledged} onChange={event => setDemoAcknowledged(event.target.checked)} />This demo uses a software signer, not physical hardware. I understand.</label>}
    {data ? <div className="space-y-1">
      <p>Pot: <strong>{formatUnits(data.round[0], 6)} USDC</strong> · {data.round[4] ? "Prize paid" : data.round[2] === zeroAddress ? "No accepted score" : `Best score: ${data.round[3]}`}</p>
      {data.round[2] !== zeroAddress && <p className="break-all">Leader: {data.round[2]}</p>}
      <p>Your best: {data.personal[0] ? data.personal[1] : "No accepted score"}</p>
      <div className="flex flex-wrap gap-2">
        {closed && data.round[2] !== zeroAddress && !data.round[4] && <Button disabled={busy} onClick={() => void run(() => settle("claim"))}>Send prize to winner</Button>}
        {closed && data.round[2] === zeroAddress && data.refundable > 0n && <Button disabled={busy} onClick={() => void run(() => settle("refund"))}>Refund {formatUnits(data.refundable, 6)} USDC</Button>}
      </div>
    </div> : <p>{roundQuery.isError ? "Chain read failed. Retry when RPC is available." : "Reading competition from chain…"}</p>}
    {selectedDay === dayOf(now) && <>
      <Button disabled={busy || !chart?.ready || !room || (chart.captureMode === "software-demo" && !demoAcknowledged)} onClick={() => void run(enter)}>{busy ? "Waiting for transaction…" : "Enter daily competition · 1 USDC"}</Button>
      {!room && chart && <p>New entries are closed near midnight to leave time for gameplay and proof confirmation.</p>}
      {!walletConnectConfigured && <p>Phone QR is unavailable until the operator configures WalletConnect. Browser extensions can still connect.</p>}
      <p className="text-muted-foreground">Phone wallet: connect using WalletConnect, scan its QR code, then approve and pay on your phone. Each retry needs a new entry. Practice remains free.</p>
    </>}
    {message && <p role="status" className="break-words">{message}</p>}
    {txHash && competitionChain.blockExplorers && <a className="underline" href={`${competitionChain.blockExplorers?.default.url}/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
    {chart && <RecoveredAttempts chartHash={chart.chartHash} />}
    <details><summary>Rankings (top 20)</summary>
      {rankingsQuery.data ? <><p className="text-muted-foreground">Indexer block {rankingsQuery.data.status.indexedBlock ?? "unknown"} · lag {rankingsQuery.data.status.lag ?? "unknown"} blocks{rankingsQuery.data.status.lastError ? " · sync error" : ""}</p>
        <ol>{rankingsQuery.data.items.map(row => <li key={row.player} className="break-all">#{row.rank} {row.player} — {row.score}</li>)}</ol>
        {!rankingsQuery.data.items.length && <p>No indexed scores yet.</p>}</> : <p>Rankings unavailable. Pot, personal best, claims and refunds use the contract directly.</p>}
    </details>
  </section>;
}
