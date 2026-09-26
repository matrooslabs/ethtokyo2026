import { getBeatmapSetFromOsz } from "./beatmapParser";
import type { BeatmapSet } from "./beatmapTypes";

const BEATMAP_URL = (import.meta.env.DEV && import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL) || import.meta.env.VITE_BEATMAP_URL || "/beatmaps/daily-demo.osz";

let archive: Promise<Blob> | undefined;
let beatmapSet: Promise<BeatmapSet> | undefined;

export function getBundledBeatmapFile(): Promise<Blob> {
  archive ??= fetch(BEATMAP_URL).then((response) => {
    if (!response.ok) {
      throw new Error(`Could not load bundled beatmap (${response.status}).`);
    }
    return response.blob();
  });
  return archive;
}

export function getBundledBeatmapSet() {
  beatmapSet ??= getBundledBeatmapFile().then(getBeatmapSetFromOsz);
  return beatmapSet;
}
