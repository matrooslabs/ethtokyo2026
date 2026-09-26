import { useEffect, useRef, useState, useCallback } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import type { Transaction } from "@mysten/sui/transactions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HomeKeysGuide } from "@/components/homeKeysGuide";
import HardwareGate from "@/components/hardware/hardwareGate";
import SuiConnectButton from "@/components/sui/suiConnectButton";
import { phoneQrConfigured } from "@/components/sui/suiProvider";
import ClaimVerification from "@/components/identity/claimVerification";
import QuickSetup from "./quickSetup";
import { GameOverlay } from "@/components/game/gameOverlay";
import { useBridgeHardware } from "@/lib/hardware/useBridgeHardware";
import { decodeHex, parseInfo } from "@/lib/hardware/protocol";
import { getBundledBeatmapFile, getBundledBeatmapSet, getPracticeBeatmapSet, PRACTICE_BEATMAP_SET_ID } from "@/lib/bundledBeatmap";
import { parseOsz } from "@/lib/beatmapParser";
import { chartFromBeatmap, chartHash } from "@/lib/sui/chart";
import { loadAssets } from "@/osuMania/assets";
import { defaultSettings } from "@/stores/settingsStore";
import { encodeMods } from "@/lib/replay";
import { useGameStore } from "@/stores/gameStore";
import {
  buyPlays, configured, difficultyCode, readCompetition, readRankings, readRounds,
  refund, settle, startPaid, suiDeployment, type Difficulty, type Ranking,
} from "@/lib/sui/competition";
import type { BeatmapSet } from "@/lib/beatmapTypes";

const payoutShares = [40, 20, 20, 10, 10] as const;
const proofBufferSeconds = Number(import.meta.env.VITE_SUI_PROOF_BUFFER_SECONDS);
const proofBufferConfigured = Number.isSafeInteger(proofBufferSeconds) && proofBufferSeconds > 0;
const forestNoteCounts: Record<Difficulty, number> = { Easy: 204, Hard: 1026 };
const forestSourceHashes: Record<Difficulty, string> = {
  Easy: "1d7ac98afaacbae81cfe6ddd8950abdec91aefdc08c45193851afe60787c7c6b",
  Hard: "b6722bce5ec6308c06020d708271cc89c5398e374e5b7b6b59c6ade444bc78f3",
};
// Both chart tails end near 138 seconds; allow one extra second beyond parsed chart metadata.
const forestDurationSeconds = 139;

export default function DailyCompetition() {
  const account = useCurrentAccount();
  const wallet = useDAppKit();
  const client = useCurrentClient();
  const queryClient = useQueryClient();
  const hardware = useBridgeHardware();
  const [difficulty, setDifficulty] = useState<Difficulty>("Easy");
  const [beatmapSet, setBeatmapSet] = useState<BeatmapSet | null>(null);
  const [setupPaid, setSetupPaid] = useState(false);
  const beatmap = beatmapSet?.beatmaps.find((map) => map.cs === 4 && (!setupPaid || map.version === difficulty));
  const chartHashExpected = suiDeployment.charts[difficulty];
  const paidAttempt = useGameStore.use.paidAttempt();
  const activeBeatmapId = useGameStore.use.beatmapId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [screen, setScreen] = useState<"home" | "setup" | "claim">("home");
  const [claimId, setClaimId] = useState(suiDeployment.challengeId);
  const actionLock = useRef(false);
  const address = account?.address || "0x0";
  const tokenLabel = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "USDC" : "test USDC";
  const state = useQuery({
    queryKey: ["sui-forest-challenge-v2", suiDeployment.challengeId, address],
    enabled: configured,
    queryFn: () => readCompetition(client, address, suiDeployment.challengeId, difficulty, chartHashExpected),
    refetchInterval: 12000,
    retry: false,
  });
  const standings = useQuery({
    queryKey: ["sui-rankings", suiDeployment.challengeId, difficulty],
    enabled: configured,
    queryFn: () => readRankings(client, suiDeployment.challengeId, difficulty),
    refetchInterval: 15000,
    retry: false,
  });
  const selectedChart = useQuery({
    queryKey: ["forest-chart", beatmap?.sourceHash, chartHashExpected],
    enabled: configured && setupPaid && !!beatmap,
    queryFn: async () => {
      if (!beatmap) throw new Error("Select a Forest difficulty before verifying its Sui chart.");
      const parsed = await parseOsz(await getBundledBeatmapFile(), beatmap, encodeMods(defaultSettings.mods), undefined, true);
      if (!beatmap.sourceHash || parsed.sourceHash !== beatmap.sourceHash || parsed.sourceHash !== forestSourceHashes[difficulty]) {
        throw new Error("The loaded Forest chart does not match this difficulty.");
      }
      const hash = await chartHash(chartFromBeatmap(parsed));
      if (hash.toLowerCase() !== chartHashExpected.toLowerCase()) {
        throw new Error("The loaded Forest chart does not match the configured Sui chart hash.");
      }
      return hash;
    },
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
  const rounds = useQuery({
    queryKey: ["sui-challenge-rounds", suiDeployment.packageId, chartHashExpected],
    enabled: configured && screen === "claim",
    queryFn: () => readRounds(client, chartHashExpected),
  });
  const claimState = useQuery({
    queryKey: ["sui-forest-claim-v2", claimId, difficulty, chartHashExpected, address],
    enabled: configured && screen === "claim",
    queryFn: () => readCompetition(client, address, claimId, difficulty, chartHashExpected),
    refetchInterval: 12000,
    retry: false,
  });
  const selectedRound = claimState.data;
  const updateClaim = useCallback((ready: boolean) => {
    if (ready) void queryClient.invalidateQueries({ queryKey: ["sui-forest-claim-v2", claimId] });
  }, [claimId, queryClient]);
  const competition = state.data;
  const remaining = competition?.remaining ?? 0n;
  const correctDevice = !!competition && hardware.info?.deviceAddress.toLowerCase() === competition.device.toLowerCase();
  const chartMatches = !!competition && competition.chartHashes[difficulty].toLowerCase() === chartHashExpected.toLowerCase();
  const timeRemainingMs = Math.max(0, (competition?.scoreDeadlineMs ?? 0) - now);
  const latestSafeStartMs = (competition?.scoreDeadlineMs ?? 0) - (forestDurationSeconds + proofBufferSeconds) * 1000;
  const safeTime = proofBufferConfigured && now < latestSafeStartMs;
  const deviceCapacityReady = (hardware.info?.maxEvents ?? 0) >= 2 * forestNoteCounts[difficulty];
  const canBuy = !!account && hardware.ready && correctDevice && chartMatches && deviceCapacityReady && !!selectedChart.data && !!scorer.data && safeTime;
  const canStart = canBuy && remaining > 0n;
  const canSettle = !!selectedRound && !selectedRound.settled && now > selectedRound.claimDeadlineMs;
  const canRefund = !!account && !!selectedRound?.refundEligible;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
    if (screen === "claim") await claimState.refetch();
    else await state.refetch();
    return confirmed.Transaction;
  }

  async function prepareSetup(paid: boolean) {
    if (actionLock.current || paidAttempt || activeBeatmapId !== null ||
        (paid && (!account || !hardware.ready || !correctDevice || !chartMatches || !scorer.data || !safeTime || !deviceCapacityReady))) return;
    actionLock.current = true;
    setBusy(true);
    setSetupPaid(paid);
    setBeatmapSet(null);
    setScreen("setup");
    setMessage("");
    try {
      const loaded = paid ? await getBundledBeatmapSet() : await getPracticeBeatmapSet();
      const maps = loaded.beatmaps.filter((map) => map.cs === 4);
      if (paid && (maps.length !== 2 || !(["Easy", "Hard"] as const).every((name) => {
        const chart = maps.find((map) => map.version === name);
        return chart && chart.count_circles + chart.count_sliders === forestNoteCounts[name] &&
          chart.sourceHash === forestSourceHashes[name];
      }))) throw new Error("Forest Easy and Hard do not match the registered charts.");
      if (!paid && (loaded.id !== PRACTICE_BEATMAP_SET_ID || maps.length !== 1)) {
        throw new Error("Practice beatmap is unavailable.");
      }
      setBeatmapSet(loaded);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setScreen("home");
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  }

  async function purchase() {
    if (!canBuy || !competition || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const preflight = await hardware.getPreflight();
      if (preflight.deviceAddress.toLowerCase() !== competition.device.toLowerCase()) {
        throw new Error("Connect the controller registered for this round.");
      }
      if (parseInfo(decodeHex(preflight.infoHex, 128)).maxEvents < 2 * forestNoteCounts[difficulty]) {
        throw new Error(`Controller capacity too low for ${difficulty}. No payment was made.`);
      }
      if (Date.now() >= latestSafeStartMs) throw new Error("Not enough time remains to finish a signed Forest score before the six-hour cutoff.");
      const transaction = await transact(buyPlays(suiDeployment.challengeId));
      setMessage(`Payment confirmed on Sui: ${transaction.digest}. Three plays added for either difficulty.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  }

  async function beginPaidRun() {
    if (!canStart || !account || !competition || !beatmap || !beatmapSet || actionLock.current) {
      setMessage("Check the wallet, controller, and plays before starting.");
      return;
    }
    actionLock.current = true;
    setBusy(true);
    setMessage("");
    let spent = false;
    try {
      const file = await getBundledBeatmapFile();
      const parsed = await parseOsz(file, beatmap, encodeMods(defaultSettings.mods), undefined, true);
      if (!beatmap.sourceHash || parsed.sourceHash !== beatmap.sourceHash) {
        throw new Error("The loaded chart is not the registered competition chart.");
      }
      const loadedHash = await chartHash(chartFromBeatmap(parsed));
      if (loadedHash.toLowerCase() !== chartHashExpected.toLowerCase() ||
          loadedHash.toLowerCase() !== competition.chartHashes[difficulty].toLowerCase()) {
        throw new Error("This difficulty does not match its registered Sui chart.");
      }
      await loadAssets();
      const preflight = await hardware.getPreflight();
      if (preflight.deviceAddress.toLowerCase() !== competition.device.toLowerCase()) {
        throw new Error("Connect the controller registered for this round.");
      }
      if (parseInfo(decodeHex(preflight.infoHex, 128)).maxEvents < 2 * forestNoteCounts[difficulty]) {
        throw new Error(`Controller capacity too low for ${difficulty}. No play was spent.`);
      }
      if (Date.now() >= latestSafeStartMs) throw new Error("Not enough time remains to submit a signed score before the six-hour cutoff.");
      const transaction = await transact(startPaid(suiDeployment.challengeId, difficulty));
      spent = true;
      const event = transaction.events?.find((row) => {
        const payload = row.json;
        return row.eventType.endsWith("::competition::PaidAttemptStarted") &&
          payload && typeof payload === "object" && "challenge" in payload && "difficulty" in payload &&
          payload.challenge === suiDeployment.challengeId && Number(payload.difficulty) === difficultyCode(difficulty);
      });
      const eventPayload = event?.json;
      const sessionId = eventPayload && typeof eventPayload === "object" && "session" in eventPayload &&
        typeof eventPayload.session === "string" ? eventPayload.session : undefined;
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
        sessionId, player: account.address, challengeId: suiDeployment.challengeId, difficulty,
        webBeatmapHash: parsed.sourceHash, scoreDeadlineMs: competition.scoreDeadlineMs, captureMode: "hardware",
      });
      setScreen("home");
      setMessage(`1 play spent. ${Math.max(0, Number(remaining) - 1)} left. Leaving ends this run.`);
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : String(error)}${spent ? " This play was spent and cannot be resumed." : " No play was spent."}`);
      if (spent) void hardware.abortRecording().catch(() => {});
    } finally {
      setBusy(false);
      if (spent) void state.refetch();
      actionLock.current = false;
    }
  }

  function practice() {
    if (!hardware.ready || !beatmapSet || !beatmap) {
      setScreen("home");
      setMessage("Connect the controller and load the demo chart before practicing.");
      return;
    }
    useGameStore.getState().setBeatmapSet(beatmapSet);
    useGameStore.getState().startGame(beatmap.id);
    setScreen("home");
  }

  return (
    <>
      <GameOverlay hardware={hardware} />
      {screen === "claim" ? (
        <section className="arena-panel arena-claim-screen" aria-label="Prize claims">
          <button className="arena-text-button" onClick={() => setScreen("home")}>Back</button>
          <h1>Prize claims</h1>
          <p>World ID: one claim per person. {difficulty}: {difficulty === "Easy" ? 30 : 70}% of the pot; top five split 40/20/20/10/10%.</p>
          {configured && <label className="arena-date" htmlFor="claim-round">
            Round
            <select id="claim-round" value={claimId} onChange={(event) => setClaimId(event.target.value)}>
              {[
                { id: suiDeployment.challengeId, date: competition?.roundDate || "Current challenge" },
                ...(rounds.data || []).filter((item) => item.id !== suiDeployment.challengeId),
              ].map((item) => <option value={item.id} key={item.id}>{item.date}</option>)}
            </select>
          </label>}
          {rounds.isError && <p role="status">Past rounds unavailable. Current round remains accessible.</p>}
          {claimState.isError && <p role="alert">{claimState.error instanceof Error ? claimState.error.message : "Could not read this challenge from Sui."}</p>}
          {selectedRound ? <>
            <strong>{difficulty} prize slice ({difficulty === "Easy" ? 30 : 70}%): {(
              Number((selectedRound.settled ? selectedRound.originalPot : selectedRound.pot) * BigInt(difficulty === "Easy" ? 30 : 70) / 100n) / 1_000_000
            ).toFixed(2)} {tokenLabel}</strong>
            {selectedRound.rankedClaims[difficulty].length > 0 ? <ol className="arena-winners">
              {selectedRound.rankedClaims[difficulty].map((claim, index) => <li key={claim.wallet}>
                <span>{index + 1}. {claim.wallet.slice(0, 8)}…{claim.wallet.slice(-4)}</span>
                <strong>{payoutShares[index]}% of slice · {(
                  Number((selectedRound.settled ? selectedRound.originalPot : selectedRound.pot) * BigInt(difficulty === "Easy" ? 30 : 70) * BigInt(payoutShares[index]) / 10_000n) / 1_000_000
                ).toFixed(2)} {tokenLabel}</strong>
              </li>)}
            </ol> : <p>No World-verified {difficulty} claims yet.</p>}
            {!selectedRound.settled && now <= selectedRound.scoreDeadlineMs && <p>Claims open after scores close.</p>}
            {!selectedRound.settled && now > selectedRound.scoreDeadlineMs && now <= selectedRound.claimDeadlineMs && (
              !account ? <SuiConnectButton /> : selectedRound.claimRegistered ? <p role="status">Claim registered. Rankings settle after the claim window.</p> :
                <ClaimVerification challengeId={claimId} difficulty={difficulty === "Easy" ? "easy" : "hard"} onReady={updateClaim} />
            )}
            {canSettle && <>
              {!account && <SuiConnectButton />}
              <button className="arena-primary" disabled={!account || busy} onClick={() => {
                setBusy(true);
                void transact(settle(claimId)).then(() => setMessage("Prize shares distributed on Sui."),
                  (error) => setMessage(String(error))).finally(() => setBusy(false));
              }}>Distribute prizes</button>
            </>}
            {selectedRound.settled && <p role="status">Prize shares paid to verified wallets.</p>}
            {canRefund && <button className="arena-secondary" disabled={busy} onClick={() => {
              setBusy(true);
              void transact(refund(address, claimId)).then(() => setMessage("Unused shares refunded on Sui."),
                (error) => setMessage(String(error))).finally(() => setBusy(false));
            }}>Refund unused share</button>}
          </> : !configured ? <p role="status">No challenge yet.</p> : !claimState.isError && <p role="status">Loading claim…</p>}
        </section>
      ) : screen === "setup" ? (
        beatmapSet && beatmap ? <>
          {setupPaid && <section className="arena-entry" aria-label="Shared paid plays">
            <p role="status">{String(remaining)} shared plays left · {difficulty} needs {2 * forestNoteCounts[difficulty]} controller events</p>
            {selectedChart.isPending && <p role="status">Checking loaded chart against Sui before payment…</p>}
            {selectedChart.isError && <p role="alert">{selectedChart.error instanceof Error ? selectedChart.error.message : "Forest chart hash check failed."}</p>}
          </section>}
          {setupPaid && !canStart ? <section className="arena-panel" aria-label="Paid entry status">
            <button className="arena-text-button" onClick={() => setScreen("home")}>Back</button>
            {remaining === 0n && <button className="arena-primary" disabled={!canBuy || busy} onClick={() => void purchase()}>Buy 3 shared plays for 1 {tokenLabel}</button>}
            {!safeTime && <p role="alert">Not enough time remains for this Forest chart and the configured proof reserve before the six-hour score cutoff.</p>}
            {!deviceCapacityReady && <p role="alert">Controller capacity too low for {difficulty}: {2 * forestNoteCounts[difficulty]} events required.</p>}
          </section> : <QuickSetup beatmap={beatmap} beatmapSet={beatmapSet} paid={setupPaid} busy={busy}
            onBack={() => setScreen("home")} onStart={setupPaid ? () => void beginPaidRun() : practice} />}
        </> : <section className="arena-panel" aria-busy={busy}>
          <button className="arena-text-button" disabled={busy} onClick={() => setScreen("home")}>Back</button>
          <p role="status">Loading {setupPaid ? `Forest ${difficulty}` : "practice"} chart…</p>
        </section>
      ) : (
        <>
          <section className="arena-hero">
            <div className="arena-hero-copy">
              <h1>Forest of Clock</h1>
              <p className="arena-intro">One six-hour challenge for Easy and Hard.</p>
              <HomeKeysGuide />
              {competition && <p className="arena-round-timer" role="status">Score cutoff in {Math.floor(timeRemainingMs / 3600000)}h {String(Math.floor(timeRemainingMs / 60000) % 60).padStart(2, "0")}m {String(Math.floor(timeRemainingMs / 1000) % 60).padStart(2, "0")}s</p>}
            </div>
            <aside className="arena-pot" aria-label="Shared prize pot"><div className="arena-pot-content">
              <p className="arena-pot-title">Shared pot</p>
              <div className="arena-pot-value">{competition ? (Number(competition.pot) / 1_000_000).toFixed(2) : "—"}<span>{tokenLabel}</span></div>
              <div className="arena-pot-slices"><span>Easy <strong>30%</strong></span><span>Hard <strong>70%</strong></span></div>
              <button className="arena-claim-link" onClick={() => setScreen("claim")}>Claims</button>
            </div></aside>
          </section>
          <div className="arena-competition-layout">
          <section className="arena-entry" aria-label="Enter competition">
            <fieldset className="arena-difficulty" disabled={busy || !!paidAttempt || activeBeatmapId !== null}>
              <legend>Difficulty</legend>
              <div className="arena-difficulty-toggle">
                {(["Easy", "Hard"] as const).map((next) => <button type="button" key={next} aria-pressed={difficulty === next} onClick={() => {
                  if (actionLock.current) return;
                  setDifficulty(next);
                  setClaimId(suiDeployment.challengeId);
                  setMessage("");
                }}><strong>{next}</strong><span>{forestNoteCounts[next]} notes</span></button>)}
              </div>
            </fieldset>
            <p className="arena-entry-price">1 {tokenLabel} buys 3 shared plays.</p>
            {(paidAttempt || activeBeatmapId !== null) && <p className="arena-fine-print">Finish or leave this run before changing difficulty.</p>}
            {!configured && <p className="arena-availability" role="status">Challenge not live.</p>}
            {!proofBufferConfigured && <p role="alert">Paid starts paused: score submission time is not configured.</p>}
            {hardware.ready && !deviceCapacityReady && <p role="alert">Controller supports {hardware.info?.maxEvents ?? 0} events; {difficulty} needs {2 * forestNoteCounts[difficulty]}. Provision a larger controller before buying.</p>}
            {configured && selectedChart.isError && <p role="alert">{selectedChart.error instanceof Error ? selectedChart.error.message : "Forest chart does not match this Sui challenge."}</p>}
            {configured && scorer.isError && <p role="alert">{scorer.error instanceof Error ? scorer.error.message : "Scoring server unavailable."}</p>}
            {configured ? (
              <div className="arena-entry-step">
                {!account ? <><SuiConnectButton />{phoneQrConfigured && <p className="arena-fine-print">Choose WalletConnect to scan with your phone.</p>}</> : !competition ? (
                  <p role={state.isError ? "alert" : "status"}>{state.isError ? (state.error instanceof Error ? state.error.message : "Could not load this Sui challenge.") : "Loading Sui challenge…"}</p>
                ) : !hardware.ready || !correctDevice ? (
                  <>
                    <HardwareGate hardware={hardware} />
                    {hardware.ready && !correctDevice && <p role="alert">Choose the controller for this round.</p>}
                  </>
                ) : (
                  <>
                    <p role="status">{String(remaining)} shared plays left</p>
                    {remaining > 0n ? (
                      <div className="arena-play-row">
                        <button className="arena-primary" disabled={!safeTime || !deviceCapacityReady || !chartMatches || !scorer.data || busy} onClick={() => void prepareSetup(true)}>Set up paid run</button>
                        {selectedChart.data && <button className="arena-text-button" disabled={!canBuy || busy} onClick={() => void purchase()}>Buy more plays</button>}
                      </div>
                    ) : (
                      <button className="arena-primary" disabled={!safeTime || !deviceCapacityReady || !chartMatches || !scorer.data || busy} onClick={() => void prepareSetup(true)}>Set up paid run · 3 plays for 1 {tokenLabel}</button>
                    )}
                    <p className="arena-fine-print">Starting spends 1 shared play. The configured proof reserve is held back before the six-hour cutoff.</p>
                  </>
                )}
              </div>
            ) : !hardware.ready ? <HardwareGate hardware={hardware} /> : null}
            {hardware.ready && <button className="arena-text-button" onClick={() => void prepareSetup(false)}>Practice demo</button>}
          </section>
          <section className="arena-standings" aria-label="Verified leaderboard">
            <div className="arena-section-heading"><h2>{difficulty} scores</h2></div>
            {standings.isError ? <p role="alert">Live Sui scores could not be loaded. Try again shortly.</p> :
              <div className="arena-table-scroll"><table className="arena-table"><thead><tr><th>Rank</th><th>Player</th><th>Verified score</th></tr></thead><tbody>
                {(standings.data || []).map((row: Ranking, index: number) => <tr key={row.wallet}>
                  <td>{index + 1}</td><td>{row.wallet.slice(0, 8)}…{row.wallet.slice(-4)}</td><td>{row.score.toLocaleString()}</td>
                </tr>)}
                {(!configured || standings.data?.length === 0) && <tr><td colSpan={3} className="arena-table-empty">No scores yet.</td></tr>}
              </tbody></table></div>}
          </section>
          </div>
        </>
      )}
      {message && <p className="arena-service-status" role="status">{message}</p>}
    </>
  );
}
