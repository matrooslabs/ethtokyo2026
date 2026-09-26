import { getBundledBeatmapSet } from "@/lib/bundledBeatmap";
import type { BeatmapSet as BeatmapSetData } from "@/lib/beatmapTypes";
import { useGameStore } from "@/stores/gameStore";
import { useEffect, useState } from "react";
import BeatmapSet from "./beatmapSet/beatmapSet";
const Main = () => {
  const beatmapId = useGameStore.use.beatmapId();
  const [beatmapSet, setBeatmapSet] = useState<BeatmapSetData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBundledBeatmapSet().then(setBeatmapSet, (cause) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load bundled beatmap.",
      );
    });
  }, []);

  return (
    <div hidden={!!beatmapId}>
      <h1 className="mb-4 text-2xl font-semibold">Built-in beatmap</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : beatmapSet ? (
        <BeatmapSet beatmapSet={beatmapSet} />
      ) : (
        <p role="status">Loading beatmap...</p>
      )}
    </div>
  );
};

export default Main;
