import { competitionChain } from "@/lib/walletConfig";
import { isAddress, isHex, size, type Address, type Hex } from "viem";
import { scoringUrl, leaderboardAddress, registryAddress } from "./contracts";
export type ChartSetup = {
  chartHash: Hex;
  webBeatmapHash: string;
  device: Address;
  durationSeconds: number;
  provingBufferSeconds: number;
  chainId: number;
  leaderboard: Address;
  registry: Address;
  mode: number;
  maxEnd: number;
  hardwareSrs: {
    bankHash: Hex;
    bankLength: number;
    maxEvents: number;
    srsId: Hex;
    developmentOnly: boolean;
  };
  ready: boolean;
  reason?: string;
  captureMode: "hardware";
};
export type PaidAttempt = {
  chainId: number;
  registry: Address;
  sessionId: Hex;
  entryTxHash: Hex;
  player: Address;
  chartHash: Hex;
  dayId: number;
  webBeatmapHash: string;
  captureMode: ChartSetup["captureMode"];
};
export type ProofResult = {
  chainId: number;
  registry: Address;
  sessionId: Hex;
  srsId: Hex;
  sessionDigest: Hex;
  submission: {
    sessionId: Hex;
    eventCount: number;
    root: Hex;
    commitment: [Hex, Hex];
    duration: string;
    laneBits: [number, number, number, number];
    counts: [number, number, number, number, number];
    proof: Hex[];
    signature: Hex;
  };
};
export type ProofJob = {
  status: "queued" | "proving" | "ready" | "failed";
  sessionId: Hex;
  result?: ProofResult;
  message?: string;
};
export class ScoringError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function scoringRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  if (!scoringUrl)
    throw new Error("Paid play needs a configured scoring server.");
  const response = await fetch(`${scoringUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ScoringError(
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : `Scoring server returned ${response.status}`,
      response.status,
    );
  return result as T;
}
export async function getChartSetup(hash: string): Promise<ChartSetup> {
  const chart = await scoringRequest<ChartSetup>(
    `/charts/${encodeURIComponent(hash)}`,
  );
  if (
    chart.webBeatmapHash !== hash ||
    !isHex(chart.chartHash) ||
    size(chart.chartHash) !== 32 ||
    !isAddress(chart.device) ||
    chart.chainId !== competitionChain.id ||
    chart.leaderboard?.toLowerCase() !== leaderboardAddress?.toLowerCase() ||
    !Number.isFinite(chart.durationSeconds) ||
    chart.durationSeconds <= 0 ||
    !Number.isFinite(chart.provingBufferSeconds) ||
    chart.provingBufferSeconds <= 0 ||
    chart.captureMode !== "hardware" ||
    chart.mode !== 2 ||
    !registryAddress ||
    chart.registry?.toLowerCase() !== registryAddress.toLowerCase()
  ) {
    throw new Error(
      "Prover chart configuration does not match this deployment.",
    );
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
    return {
      ...(JSON.parse(cached) as ChartSetup),
      ready: false,
      reason:
        "Prover unavailable. Settlement remains available from the contract.",
    };
  }
}
