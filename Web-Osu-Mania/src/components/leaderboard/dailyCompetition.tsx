import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import type { Transaction } from "@mysten/sui/transactions";
import { useQuery } from "@tanstack/react-query";
import { HomeKeysGuide } from "@/components/homeKeysGuide";
import HardwareGate from "@/components/hardware/hardwareGate";
import SuiConnectButton from "@/components/sui/suiConnectButton";
import WorldVerification from "@/components/identity/worldVerification";
import { GameOverlay } from "@/components/game/gameOverlay";
import { useBridgeHardware } from "@/lib/hardware/useBridgeHardware";
import { getBundledBeatmapFile } from "@/lib/bundledBeatmap";
import { parseOsz } from "@/lib/beatmapParser";
import { chartFromBeatmap, chartHash } from "@/lib/sui/chart";
import { loadAssets } from "@/osuMania/assets";
import { defaultSettings } from "@/stores/settingsStore";
import { encodeMods } from "@/lib/replay";
import { useGameStore } from "@/stores/gameStore";
import {
  buyPlays, claimPrize, configured, readCompetition, readRankings,
  refund, startPaid, suiDeployment, type Ranking,
} from "@/lib/sui/competition";
import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";

export default function DailyCompetition({ beatmap, beatmapSet }: {
  beatmap: Beatmap;
  beatmapSet: BeatmapSet;
}) {
  const account = useCurrentAccount();
  const wallet = useDAppKit();
  const client = useCurrentClient();
  const hardware = useBridgeHardware();
  const [identityReady, setIdentityReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [screen, setScreen] = useState<"home" | "claim">("home");
  const address = account?.address || "0x0";
  const tokenLabel = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "USDC" : "test USDC";
  const updateIdentity = useCallback((ready: boolean) => setIdentityReady(ready), []);
  const state = useQuery({
    queryKey: ["sui-competition", suiDeployment.competitionId, address],
    enabled: configured,
    queryFn: () => readCompetition(client, address),
    refetchInterval: 12000,
    retry: false,
  });
  const standings = useQuery({
    queryKey: ["sui-rankings", suiDeployment.competitionId, state.data?.winner],
    enabled: configured,
    queryFn: () => readRankings(client, state.data?.hasWinner ? state.data.winner : undefined),
    refetchInterval: 15000,
    retry: false,
  });
  const scorer = useQuery({
    queryKey: ["sui-scorer", suiDeployment.packageId, suiDeployment.registryId],
    enabled: configured,
    queryFn: async () => {
      const response = await fetch("/api/scoring/info");
      if (!response.ok) throw new Error("Scoring server unavailable.");
      const info = await response.json() as { system?: string; registryId?: string; packageId?: string; mode?: number };
      if (info.system !== "gkr-sui-hardware" || info.mode !== 3 ||
          info.registryId !== suiDeployment.registryId || info.packageId !== suiDeployment.packageId) {
        throw new Error("Scoring server does not match this competition.");
      }
      return info;
    },
    refetchInterval: 12000,
    retry: false,
  });
  const competition = state.data;
  const remaining = competition?.remaining ?? 0n;
  const correctDevice = !!competition && hardware.info?.deviceAddress.toLowerCase() === competition.device.toLowerCase();
  const now = Date.now();
  const canBuy = !!account && (identityReady || remaining > 0n) && hardware.ready && correctDevice && !!competition && !!scorer.data && now < competition.salesDeadlineMs;
  const canStart = !!account && hardware.ready && correctDevice && remaining > 0n && !!competition && !!scorer.data && now < competition.startsDeadlineMs;
  const canClaim = !!competition && competition.hasWinner && !competition.prizePaid && now > competition.scoreDeadlineMs && now <= competition.claimDeadlineMs;
  const canRefund = !!account && !!competition && !competition.prizePaid && now > competition.scoreDeadlineMs &&
    (!competition.hasWinner || now > competition.claimDeadlineMs);

  useEffect(() => {
    const home = () => setScreen("home");
    window.addEventListener("arena:home", home);
    return () => window.removeEventListener("arena:home", home);
  }, []);

  async function transact(transaction: Transaction) {
    const result = await wallet.signAndExecuteTransaction({ transaction });
    if (!result.Transaction) throw new Error("The Sui transaction was rejected. No changes were made.");
    const confirmed = await client.waitForTransaction({ digest: result.Transaction.digest, include: { events: true, effects: true } });
    if (!confirmed.Transaction || !confirmed.Transaction.status.success) {
      throw new Error("The Sui transaction failed. Check your wallet's activity.");
    }
    await state.refetch();
    return confirmed.Transaction;
  }

  async function purchase() {
    if (!canBuy || !competition) return;
    setBusy(true);
    setMessage("");
    try {
      const preflight = await hardware.getPreflight();
      if (preflight.deviceAddress.toLowerCase() !== competition.device.toLowerCase()) {
        throw new Error("Connect the controller registered for this round.");
      }
      const transaction = await transact(buyPlays());
      setMessage(`Payment confirmed on Sui: ${transaction.digest}. Three plays added for this round.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function beginPaidRun() {
    if (!canStart || !account || !competition) return;
    setBusy(true);
    setMessage("");
    let spent = false;
    try {
      const file = await getBundledBeatmapFile();
      const parsed = await parseOsz(file, beatmap, encodeMods(defaultSettings.mods), undefined, true);
      if (!beatmap.sourceHash || parsed.sourceHash !== beatmap.sourceHash) {
        throw new Error("The loaded chart is not the registered competition chart.");
      }
      if (await chartHash(chartFromBeatmap(parsed)) !== competition.chartHash) {
        throw new Error("This song does not match the registered Sui chart.");
      }
      await loadAssets();
      const preflight = await hardware.getPreflight();
      if (preflight.deviceAddress.toLowerCase() !== competition.device.toLowerCase()) {
        throw new Error("Connect the controller registered for this round.");
      }
      const transaction = await transact(startPaid());
      spent = true;
      const event = transaction.events?.find((row) => row.eventType.endsWith("::competition::PaidAttemptStarted") &&
        (row.json as { competition?: string }).competition === suiDeployment.competitionId);
      const sessionId = (event?.json as { session?: string } | undefined)?.session;
      if (!sessionId || !/^0x[0-9a-fA-F]{64}$/.test(sessionId)) {
        throw new Error("A play was spent, but its Sui session could not be read. Check the transaction before trying again.");
      }
      const response = await fetch("/api/scoring/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, infoHex: preflight.infoHex, statusHex: preflight.statusHex }),
      });
      const started = await response.json() as { headerHex?: string; error?: string };
      const header = started.headerHex;
      if (!response.ok || !header || !/^0x[0-9a-fA-F]{584}$/.test(header)) {
        throw new Error(started.error || "Signed capture could not start. This play was spent; no resume is available.");
      }
      await hardware.setHeader(header);
      useGameStore.getState().startPaidGame(beatmapSet, beatmap.id, {
        sessionId, player: account.address, webBeatmapHash: parsed.sourceHash,
        dayId: Math.floor(Date.now() / 86400000), captureMode: "hardware",
      });
      setScreen("home");
      setMessage(`1 play spent. ${Math.max(0, Number(remaining) - 1)} left. Leaving ends this run.`);
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : String(error)}${spent ? " This play was spent and cannot be resumed." : " No play was spent."}`);
      if (spent) void hardware.abortRecording().catch(() => {});
    } finally {
      setBusy(false);
      if (spent) void state.refetch();
    }
  }

  function practice() {
    if (!hardware.ready) return;
    useGameStore.getState().setBeatmapSet(beatmapSet);
    useGameStore.getState().startGame(beatmap.id);
  }

  return (
    <>
      <GameOverlay hardware={hardware} />
      {screen === "claim" ? (
        <section className="arena-panel" aria-label="Prize settlement">
          <button className="arena-text-button" onClick={() => setScreen("home")}>Back to leaderboard</button>
          <h1>Claim the prize</h1>
          <p>After the round, send the pot to the top verified wallet.</p>
          <strong>{competition ? Number(competition.pot) / 1_000_000 : "—"} {tokenLabel}</strong>
          <p>Winning wallet: {competition?.hasWinner ? competition.winner : "No verified winner yet"}</p>
          {!account && <SuiConnectButton />}
          <button className="arena-primary" disabled={!account || !canClaim || busy} onClick={() => {
            setBusy(true);
            void transact(claimPrize()).then(() => setMessage("Prize sent to the winning Sui wallet."),
              (error) => setMessage(String(error))).finally(() => setBusy(false));
          }}>Claim winner’s prize</button>
          {canRefund && <button className="arena-secondary" disabled={busy} onClick={() => {
            setBusy(true);
            void transact(refund(address)).then(() => setMessage("Your payments were refunded on Sui."),
              (error) => setMessage(String(error))).finally(() => setBusy(false));
          }}>Claim eligible refund</button>}
        </section>
      ) : (
        <>
          <section className="arena-hero">
            <div className="arena-hero-copy">
              <h1>Play four keys.</h1>
              <p className="arena-intro">Top verified score wins today’s pot.</p>
              <HomeKeysGuide />
              <p className="arena-entry-price">3 plays for 1 {tokenLabel}</p>
            </div>
            <aside className="arena-pot"><div className="arena-pot-content">
              <p>Prize pot</p>
              <div className="arena-pot-value">{competition ? (Number(competition.pot) / 1_000_000).toFixed(2) : "—"}<span>{tokenLabel}</span></div>
              <button className="arena-claim-link" onClick={() => setScreen("claim")}>Claim prize</button>
            </div></aside>
          </section>
          <section className="arena-entry" aria-label="Enter competition">
            {!configured && <p role="alert">Competition unavailable.</p>}
            {configured && scorer.isError && <p role="alert">Scoring unavailable. Try again later.</p>}
            {(!hardware.ready || (competition && !correctDevice)) && <HardwareGate hardware={hardware} />}
            {hardware.ready && competition && !correctDevice && <p role="alert">Wrong controller for this round. Choose another device.</p>}
            {configured && hardware.ready && (!competition || correctDevice) && (
              <div className="arena-entry-step">
                {!account ? <SuiConnectButton /> : remaining === 0n && !identityReady ? (
                  <WorldVerification onReady={updateIdentity} />
                ) : (
                  <>
                    <p role="status">{competition ? `${remaining} plays left` : "Loading round…"}</p>
                    {remaining > 0n ? (
                      <div className="arena-play-row">
                        <button className="arena-primary" disabled={!canStart || busy} onClick={() => void beginPaidRun()}>Play (1 credit)</button>
                        <button className="arena-text-button" disabled={!canBuy || busy} onClick={() => void purchase()}>Buy more plays</button>
                      </div>
                    ) : (
                      <button className="arena-primary" disabled={!canBuy || busy} onClick={() => void purchase()}>Buy 3 plays for 1 {tokenLabel}</button>
                    )}
                    <p className="arena-fine-print">Starting spends 1 play. No resume.</p>
                  </>
                )}
              </div>
            )}
            {hardware.ready && <button className="arena-text-button" onClick={practice}>Free practice</button>}
          </section>
          <section className="arena-standings" aria-label="Verified leaderboard">
            <div className="arena-section-heading"><h2>Leaderboard</h2><p>{beatmapSet.title}</p></div>
            {standings.isError ? <p role="alert">Live Sui scores could not be loaded. Try again shortly.</p> :
              <div className="arena-table-scroll"><table className="arena-table"><thead><tr><th>Rank</th><th>Player</th><th>Verified score</th></tr></thead><tbody>
                {(standings.data || []).map((row: Ranking, index: number) => <tr key={row.wallet}>
                  <td>{index + 1}</td><td>{row.wallet.slice(0, 8)}…{row.wallet.slice(-4)}</td><td>{row.score.toLocaleString()}</td>
                </tr>)}
              </tbody></table></div>}
            {standings.data?.length === 0 && <p>No verified scores yet.</p>}
          </section>
        </>
      )}
      {message && <p className="arena-service-status" role="status">{message}</p>}
    </>
  );
}
