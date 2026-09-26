export type DevDifficulty = "Easy" | "Hard";

/** Only used by the local dev simulator. Never accepted as a paid Bridge attempt. */
export type DevRun = {
  id: string;
  wallet: string;
  difficulty: DevDifficulty;
};

export type DevResult = {
  runId: string;
  score: number;
  failed: boolean;
};
