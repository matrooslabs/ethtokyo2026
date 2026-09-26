import { competitionChain } from "@/lib/walletConfig";
import { isAddress, isHex, size, type Address, type Hex } from "viem";
import { bridgeUrl, leaderboardAddress } from "./contracts";
export type ChartSetup = {
  chartHash: Hex; webBeatmapHash: string; device: Address; durationSeconds: number;
  provingBufferSeconds: number; chainId: number; leaderboard: Address;
  ready: boolean; reason?: string; captureMode: "hardware" | "software-demo";
};
export type PaidAttempt = {
  sessionId: Hex; entryTxHash: Hex; player: Address; chartHash: Hex; dayId: number;
  webBeatmapHash: string; captureMode: ChartSetup["captureMode"];
};
export type ProofJob = {
  jobId?: string; status: "queued" | "capturing" | "proving" | "submitting" | "confirmed" | "failed";
  message?: string; transactionHash?: Hex; retryable?: boolean;
};
export class BridgeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function bridgeRequest<T>(path: string, body?: unknown): Promise<T> {
  if (!bridgeUrl) throw new Error("Paid play needs a configured prover bridge.");
  const response = await fetch(`${bridgeUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new BridgeError(result && typeof result === "object" && "error" in result ? String(result.error) : `Prover bridge returned ${response.status}`, response.status);
  return result as T;
}
export async function getChartSetup(hash: string): Promise<ChartSetup> {
  const chart = await bridgeRequest<ChartSetup>(`/charts/${encodeURIComponent(hash)}`);
  if (chart.webBeatmapHash !== hash || !isHex(chart.chartHash) || size(chart.chartHash) !== 32 ||
    !isAddress(chart.device) || chart.chainId !== competitionChain.id ||
    chart.leaderboard?.toLowerCase() !== leaderboardAddress?.toLowerCase() ||
    !Number.isFinite(chart.durationSeconds) || chart.durationSeconds <= 0 ||
    !Number.isFinite(chart.provingBufferSeconds) || chart.provingBufferSeconds <= 0 ||
    !["hardware", "software-demo"].includes(chart.captureMode)) {
    throw new Error("Prover chart configuration does not match this deployment.");
  }
  return chart;
}

// Cached chart identity keeps settlement accessible if the prover goes offline.
// Paid entry always calls getChartSetup directly and requires fresh readiness.
export async function getChartForDisplay(hash: string): Promise<ChartSetup> {
  const key = `paid-chart:${leaderboardAddress}:${hash}`;
  try {
    const chart = await getChartSetup(hash);
    localStorage.setItem(key, JSON.stringify(chart));
    return chart;
  } catch (error) {
    const cached = localStorage.getItem(key);
    if (!cached) throw error;
    return { ...JSON.parse(cached) as ChartSetup, ready: false, reason: "Prover unavailable. Settlement remains available from the contract." };
  }
}
