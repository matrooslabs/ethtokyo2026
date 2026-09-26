import type { PaidAttempt } from "@/lib/leaderboard/bridge";
import type { BeatmapSet } from "@/lib/beatmapTypes";
import { walletConfig } from "@/lib/walletConfig";
import { getBundledBeatmapSet } from "@/lib/bundledBeatmap";
import { createSelectors } from "@/lib/zustand";
import type { ReplayData } from "@/osuMania/systems/replayRecorder";
import { Howler } from "howler";
import { toast } from "sonner";
import { create } from "zustand";
import { getAccount } from "wagmi/actions";
import { immer } from "zustand/middleware/immer";

type GameState = {
  paidAttempt: PaidAttempt | null;
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
    startPaidGame: (beatmapSet, beatmapId, attempt) => {
      set((state) => {
        state.paidAttempt = attempt;
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
      set((state) => { state.paidAttempt = null; });
      if (!getAccount(walletConfig).isConnected) {
        toast("Connect your wallet before playing.");
        return;
      }
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
      if (!getAccount(walletConfig).isConnected) {
        toast("Connect your wallet before playing.");
        return;
      }

      try {
        const beatmapSet = await getBundledBeatmapSet();
        const beatmap = beatmapSet.beatmaps.find(
          (entry) =>
            entry.cs === 4 &&
            replay.beatmap.hash === entry.hash &&
            (!("id" in replay.beatmap) ||
              (replay.beatmap.setId === beatmapSet.id &&
                replay.beatmap.id === entry.id)),
        );
        if (!beatmap) {
          toast("Replay does not match the bundled beatmap.");
          return;
        }
        if (!getAccount(walletConfig).isConnected) {
          return;
        }
        set((state) => {
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
