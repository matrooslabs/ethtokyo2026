import type { PaidAttempt } from "@/lib/sui/paidAttempt";
import type { DevResult, DevRun } from "@/lib/dev/types";
import type { BeatmapSet } from "@/lib/beatmapTypes";
import { getBundledBeatmapSet, getPracticeBeatmapSet, PRACTICE_BEATMAP_SET_ID } from "@/lib/bundledBeatmap";
import { createSelectors } from "@/lib/zustand";
import type { ReplayData } from "@/osuMania/systems/replayRecorder";
import { Howler } from "howler";
import { toast } from "sonner";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

type GameState = {
  paidAttempt: PaidAttempt | null;
  devRun: DevRun | null;
  devResult: DevResult | null;
  recordedDevRunId: string | null;
  startDevGame: (beatmapSet: BeatmapSet, beatmapId: number, run: DevRun) => void;
  recordDevResult: (result: DevResult) => void;
  clearDevResult: () => void;
  startPaidGame: (beatmapSet: BeatmapSet, beatmapId: number, attempt: PaidAttempt) => void;
  beatmapSet: BeatmapSet | null;
  beatmapId: number | null;
  replayData: ReplayData | null;
  scrollPosition: number | null;
  startGame: (beatmapId: number) => void;
  startReplay: (replay: ReplayData) => Promise<void>;
  setBeatmapSet: (beatmapSet: BeatmapSet | null) => void;
  closeGame: () => void;
  setReplayData: (replay: ReplayData | null) => void;
};

const useGameStoreBase = create<GameState>()(
  immer((set, get) => ({
    paidAttempt: null,
    devRun: null,
    devResult: null,
    recordedDevRunId: null,
    startDevGame: (beatmapSet, beatmapId, run) => {
      if (import.meta.env.MODE !== "development" || import.meta.env.VITE_VERSU_MODE !== "dev") {
        throw new Error("Simulated runs are available only in local dev mode.");
      }
      set((state) => {
        state.paidAttempt = null;
        state.devRun = run;
        state.devResult = null;
        state.recordedDevRunId = null;
        state.beatmapSet = beatmapSet;
        state.beatmapId = beatmapId;
        state.replayData = null;
        state.scrollPosition = window.scrollY;
      });
    },
    recordDevResult: (result) => {
      set((state) => {
        if (state.devRun?.id !== result.runId || state.recordedDevRunId === result.runId) return;
        state.devResult = result;
        state.recordedDevRunId = result.runId;
      });
    },
    clearDevResult: () => {
      set((state) => {
        state.devResult = null;
      });
    },
    startPaidGame: (beatmapSet, beatmapId, attempt) => {
      set((state) => {
        state.paidAttempt = attempt;
        state.devRun = null;
        state.beatmapSet = beatmapSet;
        state.beatmapId = beatmapId;
        state.replayData = null;
        state.scrollPosition = window.scrollY;
      });
    },
    beatmapSet: null,
    beatmapId: null,
    replayData: null,
    scrollPosition: null,

    startGame: (beatmapId: number) => {
      set((state) => { state.paidAttempt = null; state.devRun = null; });
      if (
        !get().beatmapSet?.beatmaps.some(
          (beatmap) => beatmap.id === beatmapId && beatmap.cs === 4,
        )
      ) {
        toast("Only 4K beatmaps can be played.");
        return;
      }

      set((state) => {
        state.beatmapId = beatmapId;

        // Site content is hidden while playing game, so scroll position must be restored afterwards
        state.scrollPosition = window.scrollY;
      });
    },

    startReplay: async (replay: ReplayData) => {

      try {
        const match = (set: BeatmapSet) => set.beatmaps.find((entry) =>
          entry.cs === 4 && replay.beatmap.hash === entry.hash &&
          (!("id" in replay.beatmap) || (replay.beatmap.setId === set.id && replay.beatmap.id === entry.id)));
        const practice = !("id" in replay.beatmap) || replay.beatmap.setId === PRACTICE_BEATMAP_SET_ID
          ? await getPracticeBeatmapSet() : null;
        const practiceMap = practice && match(practice);
        const beatmapSet = practiceMap ? practice : await getBundledBeatmapSet();
        const beatmap = practiceMap || match(beatmapSet);
        if (!beatmap) {
          toast("Replay does not match a bundled chart.");
          return;
        }
        set((state) => {
          state.paidAttempt = null;
          state.devRun = null;
          state.beatmapId = beatmap.id;
          state.beatmapSet = beatmapSet;
          state.replayData = replay;
        });
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "Could not load bundled beatmap.",
        );
      }
    },

    closeGame: () => {
      Howler.unload();
      set((state) => {
        state.paidAttempt = null;
        state.devRun = null;
        state.beatmapId = null;
        state.replayData = null;
        state.beatmapSet = null;
      });
    },

    setReplayData: (replay: ReplayData | null) => {
      set((state) => {
        state.replayData = replay;
      });
    },

    setBeatmapSet: (beatmapSet: BeatmapSet | null) => {
      set((state) => {
        state.beatmapSet = beatmapSet;
      });
    },
  })),
);

export const useGameStore = createSelectors(useGameStoreBase);
