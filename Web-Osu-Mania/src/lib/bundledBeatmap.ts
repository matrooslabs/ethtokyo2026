import { getBeatmapSetFromOsz } from "./beatmapParser";
import type { BeatmapSet } from "./beatmapTypes";

const BEATMAP_URL = (import.meta.env.DEV && import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL) || import.meta.env.VITE_BEATMAP_URL || "/beatmaps/forest.osz";
export const PRACTICE_BEATMAP_SET_ID = 900001;
const PRACTICE_BEATMAP_URL = "/beatmaps/daily-demo.osz";

let archive: Promise<Blob> | undefined;
let beatmapSet: Promise<BeatmapSet> | undefined;
let practiceArchive: Promise<Blob> | undefined;
let practiceBeatmapSet: Promise<BeatmapSet> | undefined;

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

export function getPracticeBeatmapFile(): Promise<Blob> {
  practiceArchive ??= fetch(PRACTICE_BEATMAP_URL).then((response) => {
    if (!response.ok) throw new Error(`Could not load practice beatmap (${response.status}).`);
    return response.blob();
  });
  return practiceArchive;
}

export function getPracticeBeatmapSet(): Promise<BeatmapSet> {
  practiceBeatmapSet ??= getPracticeBeatmapFile().then(getBeatmapSetFromOsz);
  return practiceBeatmapSet;
}
