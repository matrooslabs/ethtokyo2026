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
      <div className="arena-loading" aria-busy={!error && !beatmapSet}>
        <section className="arena-hero">
          <div className="arena-hero-copy">
            <p className="arena-eyebrow">ON-CHAIN RHYTHM ARCADE</p>
            <h1>
              Hit the beat.
              <br />
              <span>Take the pot.</span>
            </h1>
            <p className="arena-intro">
              Play for the highest score. Win the entire pot.
            </p>
            <div className="arena-play-row">
              {error ? (
                <button
                  className="arena-primary arena-play"
                  onClick={() => window.location.reload()}
                >
                  Try again
                </button>
              ) : (
                <button className="arena-primary arena-play" disabled>
                  Loading…
                </button>
              )}
              <strong>1 USDC per play</strong>
            </div>
          </div>
          <aside className="arena-pot">
            <img
              className="arena-trophy-art"
              src={`${import.meta.env.BASE_URL}art/arcade-trophy.webp`}
              alt=""
              width="1254"
              height="1254"
              fetchPriority="high"
            />
            <div className="arena-pot-content">
              <p className="arena-label">CURRENT PRIZE POT</p>
              <div className="arena-pot-value">
                -<span>USDC</span>
              </div>
              <p className="arena-gold">1st place takes the entire pot</p>
              <small>Awaiting live competition data</small>
              <button className="arena-claim-link" disabled>
                Claim prize
              </button>
            </div>
          </aside>
        </section>
        <h2 className="arena-loading-heading">Leaderboard</h2>
        <p role={error ? "alert" : "status"}>
          {error ||
            (beatmapSet
              ? "No 4K chart is available in the bundled beatmap."
              : "Getting the arena ready…")}
        </p>
        {!error && !beatmapSet && (
          <div className="arena-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
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
