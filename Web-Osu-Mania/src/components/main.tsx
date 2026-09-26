import { getBundledBeatmapSet } from "@/lib/bundledBeatmap";
import type { BeatmapSet } from "@/lib/beatmapTypes";
import { useEffect, useState } from "react";
import DailyCompetition from "./leaderboard/dailyCompetition";

export default function Main() {
  const [beatmapSet, setBeatmapSet] = useState<BeatmapSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getBundledBeatmapSet().then(setBeatmapSet, (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load bundled beatmap.",
      ),
    );
  }, []);
  const beatmap = beatmapSet?.beatmaps.find((map) => map.cs === 4);
  if (!beatmapSet || !beatmap)
    return (
      <div className="arena-loading">
        <span className="arena-eyebrow">ONE BEATMAP. ONE TOP SPOT.</span>
        <h1>Find your rhythm.</h1>
        <p role={error ? "alert" : "status"}>
          {error ||
            (beatmapSet
              ? "No 4K chart is available in the bundled beatmap."
              : "Getting the arena ready…")}
        </p>
        {error && (
          <button
            className="arena-primary"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        )}
      </div>
    );
  return (
    <DailyCompetition
      beatmap={beatmap}
      beatmapSet={beatmapSet}
      stopPreview={() => {}}
    />
  );
}
