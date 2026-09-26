import { useEffect, useRef, useState } from "react";
import { GameOverlay } from "@/components/game/gameOverlay";
import QuickSetup from "@/components/leaderboard/quickSetup";
import { HomeKeysGuide } from "@/components/homeKeysGuide";
import { getBundledBeatmapSet, getPracticeBeatmapSet } from "@/lib/bundledBeatmap";
import {
  DEV_WALLETS, abortRun, advanceClock, buyPlays, claimPrize, initialState,
  launchChallenge, rankings, recordScore, refund, settle, startPlay,
  type DevState,
} from "@/lib/dev/competition";
import type { DevDifficulty } from "@/lib/dev/types";
import type { BridgeHardware } from "@/lib/hardware/useBridgeHardware";
import type { BeatmapSet } from "@/lib/beatmapTypes";
import { useGameStore } from "@/stores/gameStore";
import { useChallengeClockStore } from "@/stores/challengeClockStore";

const STORAGE_KEY = "versu:local-simulation:v2";
const unreachableBridge = async (): Promise<never> => { throw new Error("The simulator cannot use a Bridge device."); };
const simulatedHardware: BridgeHardware = {
  phase: "ready", ready: true, info: null, status: null, error: null,
  disconnectSignal: new AbortController().signal, connect: unreachableBridge,
  refresh: unreachableBridge, getPreflight: unreachableBridge, setHeader: unreachableBridge,
  startRecording: unreachableBridge, stopRecording: unreachableBridge, abortRecording: unreachableBridge,
};
const money = (units: number) => (units / 1_000_000).toFixed(2);
const defaultScheduledStart = () => {
  const date = new Date(Date.now() + 5 * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export default function DevCompetition() {
  const [state, setState] = useState<DevState>(() => initialState(0));
  const stateRef = useRef(state);
  const [loaded, setLoaded] = useState(false);
  const [scheduledStart, setScheduledStart] = useState("");
  const [wallet, setWallet] = useState(DEV_WALLETS[0].wallet);
  const [connected, setConnected] = useState(false);
  const [humanId, setHumanId] = useState(DEV_WALLETS[0].wallet);
  const [difficulty, setDifficulty] = useState<DevDifficulty>("Easy");
  const [setup, setSetup] = useState<{ paid: boolean; beatmapSet: BeatmapSet } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const processed = useRef<string | null>(null);
  const devResult = useGameStore.use.devResult();
  const devRun = useGameStore.use.devRun();
  const beatmapId = useGameStore.use.beatmapId();
  const setClock = useChallengeClockStore((value) => value.setClock);
  const clearClock = useChallengeClockStore((value) => value.clearClock);

  const commit = (next: DevState) => { stateRef.current = next; setState(next); };
  const act = (transition: (current: DevState) => DevState) => {
    try { commit(transition(stateRef.current)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const restored: DevState = saved ? JSON.parse(saved) as DevState : initialState(Date.now());
      commit(restored.run ? abortRun(restored, restored.run.id) : restored);
    } catch {
      commit(initialState(Date.now()));
    }
    setScheduledStart(defaultScheduledStart());
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [loaded, state]);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => {
      commit(advanceClock(stateRef.current, stateRef.current.nowMs + 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loaded]);
  useEffect(() => {
    if (!loaded || !devResult || processed.current === devResult.runId) return;
    processed.current = devResult.runId;
    try {
      commit(recordScore(stateRef.current, devResult));
      setNotice(devResult.failed ? "Run ended. The play was spent." : `Simulated score recorded: ${devResult.score.toLocaleString()}`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    useGameStore.getState().clearDevResult();
  }, [devResult, loaded]);
  useEffect(() => {
    const run = state.run;
    if (loaded && run && !devRun && !devResult && beatmapId === null) {
      act((current) => abortRun(current, run.id));
      setNotice("Run left early. The play was spent.");
    }
  }, [loaded, state.run, devRun, devResult, beatmapId]);
  useEffect(() => {
    if (!loaded || !state.id) { clearClock(); return; }
    const phase = state.startedAtMs !== null && state.nowMs < state.startedAtMs ? "upcoming" :
      state.scoreDeadlineMs !== null && state.nowMs < state.scoreDeadlineMs ? "scoring" :
        state.claimDeadlineMs !== null && state.nowMs < state.claimDeadlineMs ? "claims" : null;
    setClock({ phase, deadlineMs: phase === "upcoming" ? state.startedAtMs :
      phase === "scoring" ? state.scoreDeadlineMs : phase === "claims" ? state.claimDeadlineMs : null,
    nowMs: state.nowMs, simulated: true });
  }, [loaded, state, setClock, clearClock]);
  useEffect(() => () => clearClock(), [clearClock]);

  const player = state.players[wallet];
  const chart = setup?.beatmapSet.beatmaps.find((entry) => entry.cs === 4 && (!setup.paid || entry.version === difficulty));
  const scoreOpen = state.startedAtMs !== null && state.nowMs >= state.startedAtMs &&
    state.scoreDeadlineMs !== null && state.nowMs < state.scoreDeadlineMs;
  const claimOpen = state.scoreDeadlineMs !== null && state.claimDeadlineMs !== null &&
    state.nowMs >= state.scoreDeadlineMs && state.nowMs < state.claimDeadlineMs;
  const canSettle = state.claimDeadlineMs !== null && state.nowMs >= state.claimDeadlineMs && !state.settled;
  const scores = rankings(state, difficulty);

  async function prepare(paid: boolean) {
    if (busy || state.run) return;
    setBusy(true);
    setError("");
    try {
      const beatmapSet = paid ? await getBundledBeatmapSet() : await getPracticeBeatmapSet();
      const charts = beatmapSet.beatmaps.filter((entry) => entry.cs === 4);
      if (paid && (charts.length !== 2 || !charts.some((entry) => entry.version === difficulty))) {
        throw new Error("Forest Easy and Hard are unavailable.");
      }
      if (!paid && charts.length !== 1) throw new Error("Practice chart is unavailable.");
      setSetup({ paid, beatmapSet });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  function begin() {
    if (!setup || !chart) return;
    if (!setup.paid) {
      useGameStore.getState().setBeatmapSet(setup.beatmapSet);
      useGameStore.getState().startGame(chart.id);
      setSetup(null);
      return;
    }
    try {
      const runId = crypto.randomUUID();
      const next = startPlay(stateRef.current, wallet, difficulty, runId);
      useGameStore.getState().startDevGame(setup.beatmapSet, chart.id, { id: runId, wallet, difficulty });
      commit(next);
      setSetup(null);
      setNotice("1 demo play spent. Local score only; no Bridge proof or Sui transaction.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function mockScore() {
    try {
      const runId = crypto.randomUUID();
      const playerIndex = DEV_WALLETS.findIndex((identity) => identity.wallet === wallet);
      const score = 950_000 - playerIndex * 25_000 - (difficulty === "Easy" ? 30_000 : 0);
      commit(recordScore(startPlay(stateRef.current, wallet, difficulty, runId), { runId, score, failed: false }));
      setNotice(`Mock score ${score.toLocaleString()} recorded. No Bridge proof or Sui transaction.`);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function reset() {
    useGameStore.getState().closeGame();
    useGameStore.getState().clearDevResult();
    localStorage.removeItem(STORAGE_KEY);
    commit(initialState(Date.now()));
    setScheduledStart(defaultScheduledStart());
    setWallet(DEV_WALLETS[0].wallet);
    setHumanId(DEV_WALLETS[0].wallet);
    setConnected(false);
    setSetup(null);
    setError("");
    setNotice("");
  }

  return <div className="arena-dev">
    <GameOverlay hardware={simulatedHardware} />
    <div className="arena-dev-banner" role="status">
      <span><strong>Simulation only.</strong> Wallet, USDC, Bridge and World ID are mocked.</span>
      <button className="arena-text-button" type="button" onClick={reset}>Reset</button>
    </div>
    {setup && chart ? <QuickSetup beatmap={chart} beatmapSet={setup.beatmapSet} paid={setup.paid} simulated busy={busy}
      onBack={() => setSetup(null)} onStart={begin} /> : <>
      <div className="arena-dev-top"><h1>Forest of Clock</h1></div>
      <HomeKeysGuide />
      <div className="arena-dev-controls">
        {!state.id ? <>
          <label>Start time (local)<input type="datetime-local" value={scheduledStart} onChange={(event) => setScheduledStart(event.target.value)} /></label>
          <button className="arena-primary" disabled={!loaded || !scheduledStart} onClick={() =>
            act((current) => launchChallenge(current, crypto.randomUUID(), new Date(scheduledStart).getTime()))}>Schedule six-hour challenge</button>
        </> : <>
          <span>Easy pool: {money(state.pots.Easy)} demo USDC · Hard pool: {money(state.pots.Hard)} demo USDC</span>
          {state.startedAtMs !== null && state.nowMs < state.startedAtMs && <button className="arena-text-button" onClick={() =>
            act((current) => advanceClock(current, current.startedAtMs!))}>Advance to scheduled start</button>}
          {scoreOpen && <button className="arena-text-button" onClick={() => act((current) => advanceClock(current, current.scoreDeadlineMs!))}>Close scoring (+6h)</button>}
          {claimOpen && <button className="arena-text-button" onClick={() => act((current) => advanceClock(current, current.claimDeadlineMs!))}>Close claims (+24h)</button>}
        </>}
      </div>
      <div className="arena-competition-layout">
        <section className="arena-entry" aria-label="Simulated entry">
          <fieldset className="arena-difficulty"><legend>Difficulty</legend><div className="arena-difficulty-toggle">
            {(["Easy", "Hard"] as const).map((name) => <button type="button" key={name} aria-pressed={name === difficulty}
              disabled={!!state.run} onClick={() => setDifficulty(name)}><strong>{name}</strong><span>{money(state.pots[name])} demo USDC</span></button>)}
          </div></fieldset>
          <div className="arena-dev-controls">
            <label>Mock wallet <select value={wallet} onChange={(event) => { setWallet(event.target.value); setHumanId(event.target.value); setConnected(false); }}>
              {DEV_WALLETS.map((identity) => <option value={identity.wallet} key={identity.wallet}>{identity.name}</option>)}
            </select></label>
            {!connected ? <button className="arena-secondary" onClick={() => setConnected(true)}>Connect mock wallet</button> :
              <span>{player.name}: {money(player.balance)} demo USDC</span>}
          </div>
          {connected && <div className="arena-play-balance" role="status"><strong>{player.credits[difficulty]}</strong><span>{difficulty} plays left</span></div>}
          {scoreOpen && connected && <div className="arena-dev-controls">
            {player.credits[difficulty] > 0 ? <>
              <button className="arena-primary" disabled={busy || !!state.run} onClick={() => void prepare(true)}>Set up Forest run</button>
              <button className="arena-text-button" onClick={() => act((current) => buyPlays(current, wallet, difficulty))}>Buy more {difficulty} plays</button>
              <button className="arena-text-button" disabled={busy || !!state.run} onClick={mockScore}>Mock score (1 {difficulty} play)</button>
            </> : <button className="arena-primary" onClick={() => act((current) => buyPlays(current, wallet, difficulty))}>Buy 3 {difficulty} plays (1 demo USDC)</button>}
          </div>}
          <button className="arena-text-button" disabled={busy || !!state.run} onClick={() => void prepare(false)}>Practice demo</button>
          {claimOpen && connected && <div className="arena-dev-claim">
            <p>One claim per simulated person across both charts. The top five claimed {difficulty} scores share only the {difficulty} pool; unused shares refund only {difficulty} purchasers.</p>
            <label>Mock World ID <select value={humanId} onChange={(event) => setHumanId(event.target.value)}>
              {DEV_WALLETS.map((identity) => <option value={identity.wallet} key={identity.wallet}>{identity.name}</option>)}
            </select></label>
            {player.claim ? <p role="status">Claimed {player.claim}</p> :
              <button className="arena-primary" disabled={!player.best[difficulty]} onClick={() => act((current) => claimPrize(current, wallet, difficulty, humanId))}>Claim {difficulty}</button>}
          </div>}
          {canSettle && <button className="arena-primary" onClick={() => act(settle)}>Distribute prizes</button>}
          {state.settled && <div className="arena-dev-claim">
            <p>Prizes sent: {DEV_WALLETS.filter((identity) => state.players[identity.wallet].payout > 0).map((identity) =>
              `${identity.name} ${money(state.players[identity.wallet].payout)}`).join(", ") || "none"}</p>
            {DEV_WALLETS.filter((identity) => state.players[identity.wallet].purchases[difficulty] > 0 && !state.players[identity.wallet].refunded[difficulty]).map((identity) =>
              <button className="arena-text-button" key={identity.wallet} onClick={() => act((current) => refund(current, identity.wallet, difficulty))}>Refund {identity.name} ({difficulty})</button>)}
            <p>Remaining {difficulty} pool: {money(state.pots[difficulty])} demo USDC</p>
          </div>}
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </section>
        <section className="arena-standings" aria-label="Simulated leaderboard">
          <div className="arena-section-heading"><h2>{difficulty} simulated scores</h2></div>
          <p>{difficulty} purchases fund this chart alone; prizes split 40/20/20/10/10% across its top five claimed scores.</p>
          <div className="arena-table-scroll"><table className="arena-table"><thead><tr><th>Rank</th><th>Player</th><th>Local score</th><th>Claim</th></tr></thead><tbody>
            {scores.map((row, index) => <tr key={row.wallet}><td>{index + 1}</td><td>{row.name}</td><td>{row.score.toLocaleString()}</td><td>{row.claimRank ?? "—"}</td></tr>)}
            {scores.length === 0 && <tr><td colSpan={4} className="arena-table-empty">No simulated scores yet.</td></tr>}
          </tbody></table></div>
        </section>
      </div>
    </>}
  </div>;
}
