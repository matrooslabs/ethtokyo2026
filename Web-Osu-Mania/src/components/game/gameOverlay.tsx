import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useGameStore } from "../../stores/gameStore";
import type { ArenaSnapshot } from "./arenaHud";
import type { BridgeHardware } from "@/lib/hardware/useBridgeHardware";
import { lazy, Suspense } from "react";

const GameModal = lazy(() => import("./gameModal"));

export const GameOverlay = ({ arena, hardware }: { arena?: ArenaSnapshot; hardware: BridgeHardware }) => {
  const beatmapId = useGameStore.use.beatmapId();

  return (
    <Dialog open={!!beatmapId}>
      <DialogContent
        className="h-full w-full max-w-full border-none p-0 focus:outline-hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Game Window</DialogTitle>
        <Suspense
          fallback={
            <div className="arena-game-loading p-8" role="status">
              <h1>Loading the game…</h1>
              <p>Your run will start when the game is ready.</p>
            </div>
          }
        >
          <GameModal arena={arena} hardware={hardware} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
};
