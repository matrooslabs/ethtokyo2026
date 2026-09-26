import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { playAudioPreviewFromUrl, stopAudioPreview } from "@/lib/audio";
import type { BeatmapSet as BeatmapSetData } from "@/lib/beatmapTypes";
import { useState } from "react";
import { parseStarsParam } from "@/lib/searchParams/starsParam";
import { Route } from "@/routes";
import { useSettingsStore } from "../../stores/settingsStore";
import BeatmapList from "./beatmapList";
import BeatmapSetCover from "./beatmapSetCover";
import PreviewProgressBar from "./previewProgressBar";

const BeatmapSet = ({ beatmapSet }: { beatmapSet: BeatmapSetData }) => {
  const [preview, setPreview] = useState<Howl | null>(null);
  const search = Route.useSearch();
  const { min, max } = parseStarsParam(search.stars);
  const query = search.q?.trim().toLowerCase();
  const matchesQuery =
    !query ||
    `${beatmapSet.title} ${beatmapSet.artist} ${beatmapSet.creator}`
      .toLowerCase()
      .includes(query);
  const filteredBeatmaps = matchesQuery
    ? beatmapSet.beatmaps.filter(
        (beatmap) =>
          beatmap.cs === 4 &&
          (min === null || beatmap.difficulty_rating >= min) &&
          (max === null || beatmap.difficulty_rating <= max),
      )
    : [];
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      playPreview();
    } else {
      stopPreview();
    }
  };

  const playPreview = () => {
    if (beatmapSet.previewUrl) {
      setPreview(
        playAudioPreviewFromUrl(
          beatmapSet.previewUrl,
          useSettingsStore.getState().musicVolume,
        ),
      );
    }
  };

  const stopPreview = () => {
    if (preview) {
      stopAudioPreview(preview);
      setPreview(null);
    }
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <div className="group relative">
        <PopoverTrigger className="group-hover:border-primary relative flex h-37.5 w-full flex-col overflow-hidden rounded-xl border p-4 text-start transition-colors duration-300">
          <BeatmapSetCover
            beatmapSet={beatmapSet}
            filteredBeatmaps={filteredBeatmaps}
          />

          {preview && (
            <div className="absolute inset-x-0 bottom-0">
              <PreviewProgressBar preview={preview} />
            </div>
          )}
        </PopoverTrigger>
      </div>

      <PopoverContent className="p-0">
        <BeatmapList
          beatmapSet={beatmapSet}
          filteredBeatmaps={filteredBeatmaps}
          stopPreview={stopPreview}
        />
      </PopoverContent>
    </Popover>
  );
};

export default BeatmapSet;
