import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import type { Game } from "@/osuMania/game";

export type ArenaSnapshot = {
  pot: string | null;
  rankings: { rank: number; player: string; score: string }[];
};

export default function ArenaHud({
  game,
  arena,
}: {
  game: Game;
  arena: ArenaSnapshot;
}) {
  const [score, setScore] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setScore(Math.round(game.scoreSystem.score)),
      250,
    );
    return () => clearInterval(timer);
  }, [game]);
  // Leave room for players who have moved their playfield to the side.
  if (game.settings.stagePosition !== 0) return null;
  return (
    <div className="arena-game-hud" aria-label="Competition standings">
      <aside className="arena-game-pot">
        <p>
          <Trophy size={20} /> Current prize pot
        </p>
        <div>
          {arena.pot ?? "—"}
          <span>USDC</span>
        </div>
        <small>1st place takes the entire pot</small>
      </aside>
      <aside className="arena-game-rankings">
        <h2>Leaderboard</h2>
        {arena.rankings.length ? (
          arena.rankings.slice(0, 5).map((row) => (
            <div key={row.player}>
              <span>{String(row.rank).padStart(2, "0")}</span>
              <span>
                {row.player.slice(0, 5)}…{row.player.slice(-3)}
              </span>
              <strong>{BigInt(row.score).toLocaleString()}</strong>
            </div>
          ))
        ) : (
          <p>Live standings unavailable</p>
        )}
        <div className="arena-your-run">
          <span>Your run</span>
          <strong>{score.toLocaleString()}</strong>
        </div>
      </aside>
    </div>
  );
}
