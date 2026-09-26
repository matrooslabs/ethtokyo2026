import { getBeatmapSetFromOsz } from "./beatmapParser";
import type { BeatmapSet } from "./beatmapTypes";

const BEATMAP_URL = "/beatmaps/forest.osz";

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
