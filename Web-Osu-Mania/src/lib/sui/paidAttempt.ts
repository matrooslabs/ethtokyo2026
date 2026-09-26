import type { Difficulty } from "./competition";

export type PaidAttempt = {
  sessionId: string;
  player: string;
  challengeId: string;
  difficulty: Difficulty;
  webBeatmapHash: string;
  scoreDeadlineMs: number;
  captureMode: "hardware";
};
