import DailyCompetition from "@/components/leaderboard/dailyCompetition";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";
import { useGameStore } from "../../stores/gameStore";
import { useHighScoresStore } from "../../stores/highScoresStore";
import DifficultyBadge from "./difficultyBadge";
import DifficultyBars from "./difficultyBars";
import HighScoreEntry from "./highScoreEntry";

const BeatmapList = ({
  beatmapSet,
  filteredBeatmaps,
  stopPreview,
}: {
  beatmapSet: BeatmapSet;
  filteredBeatmaps: Beatmap[];
  stopPreview: () => void;
}) => {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const setBeatmapSet = useGameStore.use.setBeatmapSet();
  const startGame = useGameStore.use.startGame();
  const highScores = useHighScoresStore.use.highScores();

  return (
    <div className="flex max-h-125 flex-col overflow-hidden rounded-xl">
      <div className="scrollbar scrollbar-track-card flex flex-col gap-2 overflow-auto p-2">
        {filteredBeatmaps.length === 0 && (
          <p className="text-muted-foreground p-4 text-center">
            No playable difficulties are available.
          </p>
        )}
        {filteredBeatmaps.length > 0 &&
          filteredBeatmaps.map((beatmap) => {
            const beatmapScores = highScores[beatmapSet.id]?.[beatmap.id] ?? [];

            return (
              <div key={beatmap.id}>
                <button
                  type="button"
                  className="w-full cursor-pointer rounded bg-slate-500/5 p-2 text-start transition hover:bg-white/5"
                  onClick={() => {
                    if (!isConnected) {
                      openConnectModal?.();
                      return;
                    }
                    stopPreview();
                    setBeatmapSet(beatmapSet);
                    startGame(beatmap.id);
                  }}
                >
                  <div className="flex gap-3">
                    <div className="grow overflow-hidden">
                      <span className="block max-w-full truncate text-start" title={beatmap.version}>
                        {beatmap.version} · Practice
                      </span>

                      <DifficultyBadge
                        difficultyRating={beatmap.difficulty_rating}
                        className="mt-1"
                      />
                    </div>
                  </div>

                  <DifficultyBars
                    taps={beatmap.count_circles}
                    holds={beatmap.count_sliders}
                    od={beatmap.accuracy}
                    hp={beatmap.drain}
                  />
                </button>

                <DailyCompetition beatmap={beatmap} beatmapSet={beatmapSet} stopPreview={stopPreview} />

                {beatmapScores.length > 0 && (
                  <Accordion type="single" collapsible className="mt-0.5">
                    <AccordionItem value="scores" className="border-none">
                      <AccordionTrigger className="text-muted-foreground p-0 px-2 text-sm">
                        {beatmapScores.length} High Score
                        {beatmapScores.length === 1 ? "" : "s"}
                      </AccordionTrigger>
                      <AccordionContent className="p-0">
                        <div className="">
                          {beatmapScores?.map((score, i) => (
                            <HighScoreEntry
                              key={i}
                              position={i + 1}
                              highScore={score}
                              beatmapSet={beatmapSet}
                              beatmap={beatmap}
                            />
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default BeatmapList;
