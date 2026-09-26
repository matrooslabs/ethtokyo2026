const RULESETS = ["fruits", "mania", "osu", "taiko"] as const;
export type Ruleset = (typeof RULESETS)[number];

const STATUSES = [
  "ranked",
  "qualified",
  "loved",
  "pending",
  "graveyard",
  "wip",
  // The bundled archive is parsed as a local beatmap.
  "local",
] as const;
export type Status = (typeof STATUSES)[number];

export type Beatmap = {
  beatmapset_id: number;
  difficulty_rating: number;
  id: number;
  mode: Ruleset;
  total_length: number;
  user_id: number;
  version: string;
  bpm: number;

  cs: number; // Key count
  accuracy: number; // OD
  drain: number; // HP

  count_circles: number; // Tap note count
  count_sliders: number; // Hold note count

  // Custom properties
  hash?: string;
};

export type BeatmapSet = {
  artist: string;
  artist_unicode: string;
  creator: string;
  id: number; // Set to 0 for local beatmaps if the set ID could not be found
  nsfw: boolean;
  offset: number;
  status: Status;
  title: string;
  title_unicode: string;
  user_id: number;

  play_count?: number;
  favourite_count?: number;
  rating?: number;
  genre_id?: number;
  language_id?: number;

  beatmaps: Beatmap[];

  // Custom properties
  coverUrl?: string;
  previewUrl?: string;
};
