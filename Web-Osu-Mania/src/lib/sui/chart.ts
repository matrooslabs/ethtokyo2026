import type { BeatmapData } from "@/lib/beatmapParser";

export type CanonicalChart = {
  key_count: 4;
  notes: Array<{ lane: number; start_us: number; end_us: number }>;
};

export function chartFromBeatmap(beatmap: BeatmapData): CanonicalChart {
  return {
    key_count: 4,
    notes: beatmap.hitObjects.filter((hit) => hit.type === "tap").map((hit) => ({
      lane: hit.column,
      start_us: Math.round((hit.time - beatmap.delay + beatmap.audioOffset) * 1000),
      end_us: Math.round((hit.endTime - beatmap.delay + beatmap.audioOffset) * 1000),
    })),
  };
}

/** scoring-core::chart_hash: domain || u16BE(1) || lanes || countBE || 17-byte notes. */
export async function chartHash(chart: CanonicalChart): Promise<string> {
  const bytes = new Uint8Array(24 + chart.notes.length * 17);
  bytes.set(new TextEncoder().encode("OSUMANIA_CHART_V1"));
  const view = new DataView(bytes.buffer);
  view.setUint16(17, 1);
  bytes[19] = chart.key_count;
  view.setUint32(20, chart.notes.length);
  for (let index = 0; index < chart.notes.length; index++) {
    const note = chart.notes[index];
    const offset = 24 + index * 17;
    if (note.lane < 0 || note.lane >= 4 || !Number.isSafeInteger(note.start_us) || !Number.isSafeInteger(note.end_us) || note.start_us < 0 || note.end_us < note.start_us) {
      throw new Error("Invalid chart notes for this Sui round.");
    }
    bytes[offset] = note.lane;
    view.setBigUint64(offset + 1, BigInt(note.start_us));
    view.setBigUint64(offset + 9, BigInt(note.end_us));
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
