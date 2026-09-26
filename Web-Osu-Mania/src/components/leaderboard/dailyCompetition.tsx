import { paidSession } from "@/lib/leaderboard/receipts";
import RecoveredAttempts from "./recoveredAttempts";
import { walletConnectConfigured, competitionChain } from "@/lib/walletConfig";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { erc20Abi, formatUnits, zeroAddress, type Hex } from "viem";
import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";
import {
  leaderboardAbi,
  leaderboardAddress,
  indexerUrl,
} from "@/lib/leaderboard/contracts";
import {
  getChartSetup,
  getChartForDisplay,
  type PaidAttempt,
} from "@/lib/leaderboard/bridge";
import {
  canEnter,
  dateDay,
  dayOf,
  endOf,
  ENTRY_FEE,
  utcDate,
} from "@/lib/leaderboard/rules";
import { useGameStore } from "@/stores/gameStore";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  ArrowRight,
  Flame,
  Play,
  QrCode,
  Trophy,
  Wallet,
  X,
} from "lucide-react";
import QuickSetup from "./quickSetup";
import { GameOverlay } from "@/components/game/gameOverlay";

type Ranking = { rank: number; player: string; score: string };
export default function DailyCompetition({
  beatmap,
  beatmapSet,
  stopPreview,
}: {
  beatmap: Beatmap;
  beatmapSet: BeatmapSet;
  stopPreview: () => void;
}) {
  const [screen, setScreen] = useState<"home" | "history" | "claim" | "setup">(
    "home",
  );
  const [waitingForWallet, setWaitingForWallet] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [pendingAttempt, setPendingAttempt] = useState<PaidAttempt | null>(
    null,
  );
  const account = useAccount();
  useEffect(() => {
    const reset = () => {
      setScreen("home");
      setSelectedDate("");
    };
    window.addEventListener("arena:home", reset);
    return () => window.removeEventListener("arena:home", reset);
  }, []);
  useEffect(() => {
    if (waitingForWallet && account.address) {
      setWaitingForWallet(false);
      setPaymentOpen(true);
    }
  }, [waitingForWallet, account.address]);
  const { openConnectModal } = useConnectModal();
  const client = usePublicClient({ chainId: competitionChain.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [selectedDate, setSelectedDate] = useState("");
  const [wallNow, setNow] = useState(0);
  const clockQuery = useQuery({
    queryKey: ["competition-clock", competitionChain.id],
    enabled: !!client,
    queryFn: async () => ({
      timestamp: Number((await client!.getBlock()).timestamp),
      observedAt: Date.now() / 1000,
    }),
    refetchInterval: 12000,
    retry: false,
  });
  const now =
    clockQuery.data && wallNow
      ? clockQuery.data.timestamp +
        Math.max(0, wallNow - clockQuery.data.observedAt)
      : wallNow;
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
  const chartQuery = useQuery({
    queryKey: ["paid-chart", beatmap.sourceHash],
    queryFn: () => getChartForDisplay(beatmap.sourceHash!),
    enabled: !!beatmap.sourceHash && !!leaderboardAddress,
    retry: false,
    refetchInterval: 30000,
  });
  const chart = chartQuery.data;
  const roundQuery = useQuery({
    queryKey: [
      "daily-round",
      leaderboardAddress,
      chart?.chartHash,
      selectedDay,
      account.address,
    ],
    enabled: !!client && !!leaderboardAddress && !!chart && now > 0,
    queryFn: async () => {
      const block = await client!.getBlock();
      const base = {
        address: leaderboardAddress!,
        abi: leaderboardAbi,
        blockNumber: block.number,
      };
      const [round, personal, refundable] = await Promise.all([
        client!.readContract({
          ...base,
          functionName: "rounds",
          args: [chart!.chartHash, BigInt(selectedDay)],
        }),
        client!.readContract({
          ...base,
          functionName: "records",
          args: [
            chart!.chartHash,
            BigInt(selectedDay),
            account.address || zeroAddress,
          ],
        }),
        client!.readContract({
          ...base,
          functionName: "refundablePayments",
          args: [
            chart!.chartHash,
            BigInt(selectedDay),
            account.address || zeroAddress,
          ],
        }),
      ]);
      return {
        round,
        personal,
        refundable,
        timestamp: Number(block.timestamp),
      };
    },
    refetchInterval: 12000,
    retry: false,
  });
  const rankingsQuery = useQuery({
    queryKey: ["daily-rankings", chart?.chartHash, selectedDay],
    enabled: !!indexerUrl && !!chart,
    queryFn: async () => {
      const responses = await Promise.all([
        fetch(
          `${indexerUrl}/charts/${chart!.chartHash}/days/${selectedDay}/rankings?limit=20`,
          { signal: AbortSignal.timeout(8000) },
        ),
        fetch(`${indexerUrl}/status`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (responses.some((response) => !response.ok))
        throw new Error("Rankings unavailable");
      const rankings = (await responses[0].json()) as { items: Ranking[] };
      const status = (await responses[1].json()) as {
        chainId: string;
        address: string;
        indexedBlock: string | null;
        lag: string | null;
        lastError: string | null;
      };
      if (
        String(status.chainId) !== String(competitionChain.id) ||
        status.address?.toLowerCase() !== leaderboardAddress?.toLowerCase()
      ) {
        throw new Error("Indexer deployment mismatch");
      }
      return { items: rankings.items as Ranking[], status };
    },
    refetchInterval: 15000,
    retry: false,
  });

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    setTxHash(undefined);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false;
      setBusy(false);
      void roundQuery.refetch();
    }
  }
  async function ensureWallet() {
    if (!account.address) {
      openConnectModal?.();
      throw new Error("Connect a wallet, then try again.");
    }
    if (account.chainId !== competitionChain.id)
      await switchChainAsync({ chainId: competitionChain.id });
    return account.address;
  }
  async function confirmed(hash: Hex) {
    setTxHash(hash);
    const receipt = await client!.waitForTransactionReceipt({
      hash,
      confirmations: 2,
    });
    if (receipt.status !== "success")
      throw new Error("Transaction reverted. No paid game started.");
    return receipt;
  }
  async function enter() {
    const player = await ensureWallet();
    if (!client || !leaderboardAddress || !beatmap.sourceHash)
      throw new Error("Deployment unavailable.");
    // Refresh readiness and chain time before asking the player to spend tokens.
    const prepared = await getChartSetup(beatmap.sourceHash);
    if (!prepared.ready)
      throw new Error(prepared.reason || "Capture/prover is not ready.");
    if (prepared.captureMode === "software-demo" && !demoAcknowledged)
      throw new Error("Acknowledge the software-signer demo before entering.");
    const duration =
      Math.max(prepared.durationSeconds, beatmap.total_length) + 5;
    let block = await client.getBlock();
    if (
      !canEnter(
        Math.max(Number(block.timestamp), Date.now() / 1000),
        duration,
        prepared.provingBufferSeconds,
      )
    ) {
      throw new Error(
        "Entry closed: there is not enough time to play and prove before midnight UTC.",
      );
    }
    const token = await client.readContract({
      address: leaderboardAddress,
      abi: leaderboardAbi,
      functionName: "token",
    });
    const allowance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [player, leaderboardAddress],
    });
    if (allowance < ENTRY_FEE) {
      setMessage("Approve 1 USDC in your wallet, then wait for confirmation.");
      await confirmed(
        await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [leaderboardAddress, ENTRY_FEE],
          chainId: competitionChain.id,
          account: player,
        }),
      );
    }
    block = await client.getBlock();
    const timestamp = Math.max(Number(block.timestamp), Date.now() / 1000);
    if (!canEnter(timestamp, duration, prepared.provingBufferSeconds))
      throw new Error(
        "Entry closed while waiting for approval. No entry payment was made.",
      );
    const day = dayOf(Number(block.timestamp));
    setMessage(
      "Confirm the 1 USDC entry in your wallet. Quick setup opens after two confirmations.",
    );
    const receipt = await confirmed(
      await writeContractAsync({
        address: leaderboardAddress,
        abi: leaderboardAbi,
        functionName: "enter",
        args: [prepared.chartHash, player, prepared.device, BigInt(day)],
        chainId: competitionChain.id,
        account: player,
      }),
    );
    const sessionId = paidSession(receipt, leaderboardAddress, {
      chartHash: prepared.chartHash,
      player,
      payer: player,
      device: prepared.device,
      dayId: BigInt(day),
      amount: ENTRY_FEE,
    });
    const attempt: PaidAttempt = {
      sessionId,
      entryTxHash: receipt.transactionHash,
      player,
      chartHash: prepared.chartHash,
      dayId: day,
      webBeatmapHash: beatmap.sourceHash,
      captureMode: prepared.captureMode,
    };
    // Persist the receipt even if the prover/start subsequently fails; payment is already final.
    try {
      localStorage.setItem(
        `paid-entry:${attempt.sessionId}`,
        JSON.stringify(attempt),
      );
    } catch {
      /* Confirmed payment still starts play when browser storage is full. */
    }
    stopPreview();
    setPendingAttempt(attempt);
    setPaymentOpen(false);
    setScreen("setup");
    setMessage(`Entry confirmed. Session ${attempt.sessionId}`);
  }
  async function settle(functionName: "claim" | "refund") {
    const player = await ensureWallet();
    if (!chart || !leaderboardAddress)
      throw new Error("Select a registered chart.");
    setMessage(`Confirm ${functionName} in your wallet.`);
    await confirmed(
      await writeContractAsync({
        address: leaderboardAddress,
        abi: leaderboardAbi,
        functionName,
        args: [chart.chartHash, BigInt(selectedDay)],
        chainId: competitionChain.id,
        account: player,
      }),
    );
    setMessage(
      functionName === "claim"
        ? "Prize sent to the winning wallet."
        : "Entry fees refunded to your wallet.",
    );
  }
  const data = roundQuery.data;
  const closed = !!data && data.timestamp >= endOf(selectedDay);
  const room =
    chart &&
    canEnter(
      now,
      Math.max(chart.durationSeconds, beatmap.total_length) + 5,
      chart.provingBufferSeconds,
    );
  const pot = data ? formatUnits(data.round[0], 6) : "—";
  const winner = data?.round[2];
  const hasWinner = !!winner && winner !== zeroAddress;
  const canClaim = closed && hasWinner && !data?.round[4];
  const rankings = rankingsQuery.data?.items || [];
  const shortAddress = (address: string) =>
    `${address.slice(0, 6)}…${address.slice(-4)}`;
  const goHome = () => {
    setSelectedDate("");
    setScreen("home");
  };
  const status = !leaderboardAddress
    ? "Competition is not configured. Practice is available."
    : chartQuery.isError
      ? "Competition connection unavailable. Practice is available."
      : chart && !chart.ready
        ? chart.reason || "Paid entry is temporarily unavailable."
        : roundQuery.isError
          ? "Unable to read the prize pot. Please try again shortly."
          : "";
  const startPractice = () => {
    if (!account.address) {
      openConnectModal?.();
      return;
    }
    stopPreview();
    useGameStore.getState().setBeatmapSet(beatmapSet);
    useGameStore.getState().startGame(beatmap.id);
    goHome();
  };
  if (screen === "setup")
    return (
      <QuickSetup
        beatmap={beatmap}
        beatmapSet={beatmapSet}
        paid={!!pendingAttempt}
        onBack={goHome}
        onStart={() => {
          if (pendingAttempt) {
            useGameStore
              .getState()
              .startPaidGame(beatmapSet, beatmap.id, pendingAttempt);
            setPendingAttempt(null);
            goHome();
          } else startPractice();
        }}
      />
    );

  const standings = (
    <section className="arena-standings" aria-label="Leaderboard">
      <div className="arena-section-heading">
        <div>
          <h2>{screen === "history" ? "Final standings" : "Leaderboard"}</h2>
          <span>The score to beat is right here.</span>
        </div>
        <div className="arena-chart-name">
          <i />
          {beatmapSet.title}
          <span className="arena-tag">4K</span>
        </div>
      </div>
      <div className="arena-table-scroll">
        <table className="arena-table">
          <thead>
            <tr>
              <th>RANK</th>
              <th>PLAYER</th>
              <th>SCORE</th>
              <th>ACCURACY</th>
              <th>MAX COMBO</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((row) => (
              <tr
                key={row.player}
                className={row.rank === 1 ? "arena-first" : ""}
              >
                <td>{String(row.rank).padStart(2, "0")}</td>
                <td>
                  <div className="arena-player">
                    <span className="arena-avatar">
                      {row.player.slice(2, 4).toUpperCase()}
                    </span>
                    <div>
                      <strong>
                        {shortAddress(row.player)}
                        {row.rank === 1 && " · Top score"}
                      </strong>
                      <small>
                        {account.address?.toLowerCase() ===
                        row.player.toLowerCase()
                          ? "Your wallet"
                          : "Verified player"}
                      </small>
                    </div>
                    {row.rank === 1 && (
                      <span className="arena-fire">
                        <Flame size={23} /> ON FIRE
                      </span>
                    )}
                  </div>
                </td>
                <td>{BigInt(row.score).toLocaleString()}</td>
                <td aria-label="Accuracy not indexed">—</td>
                <td aria-label="Combo not indexed">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rankings.length && (
        <div className="arena-empty">
          <Trophy size={30} />
          <h3>
            {rankingsQuery.isFetching
              ? "Loading the leaderboard…"
              : rankingsQuery.data
                ? "The top spot is waiting."
                : "Every great run starts here."}
          </h3>
          <p>
            {rankingsQuery.data
              ? "No scores yet for this competition. Be the first to set the pace."
              : "Live rankings are unavailable right now. Get ready with a practice run."}
          </p>
        </div>
      )}
      <div className="arena-table-footer">
        <span>
          {rankingsQuery.data
            ? `On-chain scores · Accuracy and combo are not indexed${rankingsQuery.data.status.lastError || Number(rankingsQuery.data.status.lag || 0) > 20 ? " · Rankings may be delayed" : ""}`
            : "Live standings appear when the competition is connected."}
        </span>
        {screen === "home" && (
          <button
            className="arena-text-button pink"
            onClick={() => {
              setSelectedDate(utcDate(dayOf(now) - 1));
              setScreen("history");
            }}
          >
            View leaderboard history <ArrowRight size={17} />
          </button>
        )}
      </div>
    </section>
  );

  return (
    <>
      <GameOverlay arena={{ pot: data ? pot : null, rankings }} />
      {screen !== "home" && (
        <button className="arena-text-button arena-back" onClick={goHome}>
          <ArrowLeft size={16} /> Back to current leaderboard
        </button>
      )}
      {screen === "home" && (
        <section className="arena-hero">
          <div>
            <p className="arena-eyebrow">ONE BEATMAP. ONE TOP SPOT.</p>
            <h1>
              Feel the rhythm.
              <br />
              Take the leaderboard.
            </h1>
            <p className="arena-intro">
              Put your timing to the test. Every play grows the prize pot.
              <br />
              Finish first and take it all.
            </p>
            <div className="arena-play-row">
              <button
                className="arena-primary arena-play"
                onClick={() =>
                  pendingAttempt ? setScreen("setup") : setPaymentOpen(true)
                }
              >
                Play Osu! <Play size={25} fill="currentColor" />
              </button>
              <div>
                <strong>1 USDC per play</strong>
                <p>Scan. Pay. Find your rhythm.</p>
              </div>
            </div>
          </div>
          <aside className="arena-pot">
            <p className="arena-label">CURRENT PRIZE POT</p>
            <div className="arena-pot-value">
              {pot}
              <span>USDC</span>
            </div>
            <p className="arena-gold">1st place takes the entire pot</p>
            <small>
              {data
                ? `${competitionChain.name} · Daily competition`
                : "Awaiting live competition data"}
            </small>
            <button
              className="arena-claim-link"
              onClick={() => setScreen("claim")}
            >
              Claim prize <ArrowRight size={19} />
            </button>
          </aside>
        </section>
      )}
      {screen === "history" && (
        <>
          <div className="arena-page-heading">
            <div>
              <p className="arena-eyebrow">THE RUNS THAT MADE HISTORY</p>
              <h1>Leaderboard history</h1>
              <p>Past competitions. Final scores. Every champion.</p>
            </div>
            <label className="arena-date">
              Competition date · UTC
              <input
                aria-label="Competition UTC date"
                type="date"
                max={now ? utcDate(dayOf(now) - 1) : undefined}
                value={selectedDate}
                onChange={(event) =>
                  setSelectedDate(event.target.value || utcDate(dayOf(now) - 1))
                }
              />
            </label>
          </div>
          <div className="arena-history-summary">
            <Trophy />
            <div>
              <span className="arena-label">
                {hasWinner ? "CHAMPION" : "COMPETITION"}
              </span>
              <h2>{hasWinner ? shortAddress(winner) : "No accepted winner"}</h2>
            </div>
            <div className="arena-history-pot">
              <strong>{pot} USDC</strong>
              <p>
                Prize pot
                {data?.round[4] ? " · Claimed" : closed ? " · Closed" : ""}
              </p>
            </div>
            <button
              className="arena-text-button"
              onClick={() => setScreen("claim")}
            >
              View prize <ArrowRight size={16} />
            </button>
          </div>
        </>
      )}
      {screen === "claim" ? (
        <>
          <div className="arena-page-heading">
            <div>
              <p className="arena-eyebrow arena-gold">
                FIRST PLACE. ALL YOURS.
              </p>
              <h1>Claim your prize.</h1>
              <p>Send the prize pot to the winning wallet.</p>
            </div>
          </div>
          <div className="arena-claim-grid">
            <div>
              <p className="arena-label arena-gold">
                <Trophy size={22} /> THE PRIZE POT
              </p>
              <div className="arena-pot-value">
                {pot}
                <span>USDC</span>
              </div>
              <p className="arena-intro">
                The entire prize pot.
                <br />
                Every entry helped build the reward.
              </p>
              {hasWinner && (
                <div className="arena-winner">
                  <span className="arena-label">WINNING WALLET</span>
                  <p>{winner}</p>
                  <span className="arena-label">WINNING SCORE</span>
                  <h2>{data?.round[3].toLocaleString()}</h2>
                </div>
              )}
            </div>
            <div className="arena-panel">
              <p className="arena-eyebrow arena-gold">
                {data?.round[4]
                  ? "PRIZE CLAIMED"
                  : canClaim
                    ? "READY TO CLAIM"
                    : "AWAITING FINAL RESULTS"}
              </p>
              <h2>Collect the prize</h2>
              <p>
                {canClaim
                  ? "Confirm the transaction in your wallet. The prize is sent directly to the winning player."
                  : data?.round[4]
                    ? "The prize has been sent to the winning wallet."
                    : "The prize becomes available after the daily competition closes at midnight UTC."}
              </p>
              <div className="arena-payment-total">
                <span>Competition date</span>
                <strong>{now ? utcDate(selectedDay) : "—"}</strong>
              </div>
              <button
                className="arena-primary"
                disabled={!canClaim || busy}
                onClick={() => void run(() => settle("claim"))}
              >
                {busy ? "Confirming…" : `Claim ${pot} USDC`}
              </button>
              {closed && !hasWinner && data && data.refundable > 0n && (
                <button
                  className="arena-text-button"
                  disabled={busy}
                  onClick={() => void run(() => settle("refund"))}
                >
                  Refund {formatUnits(data.refundable, 6)} USDC
                </button>
              )}
              <button
                className="arena-text-button"
                onClick={() => {
                  setSelectedDate(utcDate(dayOf(now) - 1));
                  setScreen("history");
                }}
              >
                Find a past competition <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </>
      ) : (
        standings
      )}
      {status && (
        <p className="arena-service-status" role="status">
          {status}
        </p>
      )}
      {message && (
        <p className="arena-service-status" role="status">
          {message}
        </p>
      )}
      {txHash && competitionChain.blockExplorers && (
        <a
          className="arena-text-button pink"
          href={`${competitionChain.blockExplorers.default.url}/tx/${txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          View transaction <ArrowRight size={16} />
        </a>
      )}
      {screen === "home" && (
        <div className="arena-bottom">
          <span>
            {data?.personal[0]
              ? `Your best: ${data.personal[1].toLocaleString()}`
              : "One song. Equal rules. Your best run."}
          </span>
          <button
            className="arena-text-button"
            disabled={!!pendingAttempt}
            onClick={() => setScreen("setup")}
          >
            Free practice <ArrowRight size={16} />
          </button>
          {pendingAttempt && (
            <button
              className="arena-text-button pink"
              onClick={() => setScreen("setup")}
            >
              Resume paid entry <ArrowRight size={16} />
            </button>
          )}
        </div>
      )}
      {chart && <RecoveredAttempts chartHash={chart.chartHash} />}
      <Dialog
        open={paymentOpen}
        onOpenChange={(open) => {
          if (!busy) setPaymentOpen(open);
        }}
      >
        <DialogContent
          className="arena-payment"
          aria-describedby="payment-description"
        >
          <button
            className="arena-dialog-close"
            aria-label="Close payment"
            disabled={busy}
            onClick={() => setPaymentOpen(false)}
          >
            <X size={20} />
          </button>
          <p className="arena-eyebrow">YOUR NEXT RUN STARTS HERE</p>
          <DialogTitle>Pay once. Play your best.</DialogTitle>
          <DialogDescription id="payment-description">
            Use your wallet to enter the game.
          </DialogDescription>
          <div className="arena-payment-total">
            <div>
              <strong>One play</strong>
              <p>Added to the shared prize pot</p>
            </div>
            <strong>1 USDC</strong>
          </div>
          <div className="arena-wallet-choice">
            <QrCode size={44} />
            <h3>
              {account.address
                ? "Wallet connected"
                : "Your phone is your ticket."}
            </h3>
            <p>
              {account.address
                ? shortAddress(account.address)
                : walletConnectConfigured
                  ? "Choose WalletConnect to scan a secure QR code with your phone’s wallet."
                  : "Connect a browser wallet to enter. Phone QR is not configured for this deployment."}
            </p>
            {!account.address && (
              <button
                className="arena-secondary"
                disabled={busy}
                onClick={() => {
                  setPaymentOpen(false);
                  setWaitingForWallet(true);
                  openConnectModal?.();
                }}
              >
                <Wallet size={18} /> Connect wallet
              </button>
            )}
          </div>
          {chart?.captureMode === "software-demo" && (
            <label className="arena-demo-check">
              <input
                type="checkbox"
                checked={demoAcknowledged}
                onChange={(event) => setDemoAcknowledged(event.target.checked)}
              />
              This demo uses a software signer, not physical hardware. I
              understand.
            </label>
          )}
          <button
            className="arena-primary"
            disabled={
              busy ||
              !chart?.ready ||
              !room ||
              !account.address ||
              (chart.captureMode === "software-demo" && !demoAcknowledged)
            }
            onClick={() => void run(enter)}
          >
            {busy ? "Waiting for confirmation…" : "Pay 1 USDC & continue"}
            <ArrowRight size={19} />
          </button>
          <p className="arena-payment-note">
            {status ||
              (!room && chart
                ? "Entries are closed near midnight to leave time for gameplay and proof confirmation."
                : "Confirm approval and entry in your wallet. Quick setup opens after payment is confirmed.")}
          </p>
          {message && (
            <p className="arena-payment-note" role="status">
              {message}
            </p>
          )}
          <button
            className="arena-text-button"
            disabled={busy}
            onClick={() => {
              setPaymentOpen(false);
              setPendingAttempt(null);
              setScreen("setup");
            }}
          >
            Try free practice first <ArrowRight size={16} />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
