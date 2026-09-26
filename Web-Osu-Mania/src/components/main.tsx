import { HomeKeysGuide } from "@/components/homeKeysGuide";
import { getBundledBeatmapSet } from "@/lib/bundledBeatmap";
import type { BeatmapSet } from "@/lib/beatmapTypes";
import { useEffect, useState } from "react";
import DailyCompetition from "./leaderboard/dailyCompetition";

export default function Main() {
  const [beatmapSet, setBeatmapSet] = useState<BeatmapSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getBundledBeatmapSet().then(setBeatmapSet, (cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load the song."),
    );
  }, []);
  const beatmap = beatmapSet?.beatmaps.find((map) => map.cs === 4);
  if (!beatmapSet || !beatmap) {
    return <div className="arena-loading" aria-busy={!error}>
      <h1>Play four keys.</h1>
      <HomeKeysGuide />
      <p role={error ? "alert" : "status"}>{error || (beatmapSet ? "No four-key song is available." : "Loading song…")}</p>
      {error && <button className="arena-secondary" onClick={() => window.location.reload()}>Try again</button>}
    </div>;
  }
  return <DailyCompetition beatmap={beatmap} beatmapSet={beatmapSet} />;
}
