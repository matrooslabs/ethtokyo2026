import { bridgeRequest } from "@/lib/leaderboard/bridge";
import { encodeMods } from "@/lib/replay";
import { defaultSettings } from "@/stores/settingsStore";
import { Progress } from "@/components/ui/progress";
import type { BeatmapData } from "@/lib/beatmapParser";
import { parseOsz } from "@/lib/beatmapParser";
import { getBundledBeatmapFile } from "@/lib/bundledBeatmap";
import { generateAutoReplay } from "@/lib/replay";
import { loadAssets } from "@/osuMania/assets";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useGameStore } from "../../stores/gameStore";
import { useSettingsStore } from "../../stores/settingsStore";
import GameScreens from "./gameScreens";

const GameModal = () => {
  const paidAttempt = useGameStore.use.paidAttempt();
  const beatmapSet = useGameStore.use.beatmapSet();
  const beatmapId = useGameStore.use.beatmapId();
  const closeGame = useGameStore.use.closeGame();
  const backgroundDim = useSettingsStore.use.backgroundDim();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const replayData = useGameStore.use.replayData();
  const setReplayData = useGameStore.use.setReplayData();
  const mods = useSettingsStore.use.mods();
  const [beatmapData, setBeatmapData] = useState<BeatmapData | null>(null);
  const [key, setKey] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Loading Beatmap...");
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [showHud, setShowHud] = useState(true);

  // Prevent user from selecting while game is open
  useEffect(() => {
    document.body.classList.add("select-none");

    return () => {
      document.body.classList.remove("select-none");
    };
  }, []);

  // Fetch beatmap and parse data
  useEffect(() => {
    if (!beatmapId) {
      return;
    }

    const loadBeatmap = async () => {
      if (!beatmapSet) {
        return;
      }

      let beatmapSetFile: Blob;
      try {
        beatmapSetFile = await getBundledBeatmapFile();
        setDownloadPercent(100);
      } catch (error) {
        toast("Beatmap Load Error", {
          description:
            error instanceof Error
              ? error.message
              : "Could not load bundled beatmap.",
        });
        closeGame();
        return;
      }
      try {
        setLoadingMessage("Parsing Beatmap...");

        const beatmap = beatmapSet.beatmaps.find((b) => b.id === beatmapId);

        if (!beatmap) {
          throw new Error(
            "Beatmap ID doesn't match any beatmaps (this should never happen)",
          );
        }

        // Don't use the hook.
        // This useEffect should run only once regardless of whether replayData is changed.
        const replay = useGameStore.getState().replayData;

        const parsedBeatmapData = await parseOsz(
          beatmapSetFile,
          beatmap,
          paidAttempt ? encodeMods(defaultSettings.mods) : replay?.mods,
          replay?.columnMap,
          true,
        );

        if (paidAttempt) {
          if (parsedBeatmapData.sourceHash !== paidAttempt.webBeatmapHash) {
            throw new Error("Paid entry chart does not match the loaded beatmap.");
          }
          if (Date.now() / 1000 >= (paidAttempt.dayId + 1) * 86400) {
            throw new Error("Paid round has closed. Return to the competition to check settlement.");
          }
        }

        // If autoplay is enabled and we're not already watching a replay, use a perfect replay
        if (!paidAttempt && !replay && mods.autoplay) {
          const autoReplay = generateAutoReplay(
            parsedBeatmapData,
            parsedBeatmapData.beatmapHash,
            mods,
          );

          setReplayData(autoReplay);
        }

        await loadAssets();

        if (paidAttempt) {
          setLoadingMessage("Starting signed capture…");
          const started = await bridgeRequest<{ sessionId: string; captureMode: string }>(`/sessions/${paidAttempt.sessionId}/start`, paidAttempt);
          if (started.sessionId !== paidAttempt.sessionId || started.captureMode !== paidAttempt.captureMode) {
            throw new Error("Capture session does not match the confirmed paid entry.");
          }
        }
        setBeatmapData(parsedBeatmapData);
      } catch (error: any) {
        toast("Parsing Error", {
          description: error.message,
          duration: 10000,
        });

        closeGame();
        return;
      }
    };

    loadBeatmap();
  }, [beatmapId, closeGame, setReplayData, mods]);

  // Clean up object URLs
  useEffect(() => {
    if (!beatmapData) {
      return;
    }

    return () => {
      if (beatmapData.backgroundUrl) {
        URL.revokeObjectURL(beatmapData.backgroundUrl);
      }

      if (beatmapData.videoUrl) {
        URL.revokeObjectURL(beatmapData.videoUrl);
      }

      URL.revokeObjectURL(beatmapData.song.url);

      Object.values(beatmapData.sounds).forEach((sound) => {
        if (sound.url) {
          URL.revokeObjectURL(sound.url);
        }
      });
    };
  }, [beatmapData]);

  const retry = useCallback(() => {
    if (useGameStore.getState().paidAttempt) {
      toast("Each competition attempt needs a new paid entry. Return to the beatmap to enter again.");
      return;
    }
    setKey((prev) => prev + 1);
  }, []);

  return (
    <div id="game" className="relative grid">
      {!beatmapData && (
        <div className="flex w-full items-center text-center">
          <div className="to-primary h-px grow bg-linear-to-r from-transparent"></div>

          <div className="bg-card rounded-xl border p-3 sm:p-6">
            <h1 className="text-2xl text-white sm:text-4xl">
              {loadingMessage}
            </h1>

            {loadingMessage.includes("Downloading") && (
              <Progress value={downloadPercent} className="mt-3 h-2" />
            )}
          </div>

          <div className="to-primary h-px grow bg-linear-to-l from-transparent"></div>
        </div>
      )}
      {beatmapData && (
        <>
          {beatmapData.videoUrl && (
            <video
              ref={videoRef}
              src={beatmapData.videoUrl}
              muted
              className="h-full w-full object-cover"
              style={{
                filter: `brightness(${1 - backgroundDim})`,
              }}
            />
          )}

          <GameScreens
            key={key}
            beatmapData={beatmapData}
            replayData={replayData}
            retry={retry}
            videoRef={videoRef}
            showHud={showHud}
            setShowHud={setShowHud}
          />
        </>
      )}
    </div>
  );
};

export default GameModal;
