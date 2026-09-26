import { HomeKeysGuide } from "@/components/homeKeysGuide";
import DailyCompetition from "./leaderboard/dailyCompetition";

export default function Main() {
  if ((import.meta.env.VITE_BEATMAP_URL && import.meta.env.VITE_BEATMAP_URL !== "/beatmaps/forest.osz") ||
      (import.meta.env.DEV && import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL &&
        import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL !== "/beatmaps/forest.osz")) {
    return <div className="arena-loading" role="alert">
      <h1>Play four keys.</h1>
      <HomeKeysGuide />
      <p>Forest archive is not configured. Set VITE_BEATMAP_URL=/beatmaps/forest.osz.</p>
    </div>;
  }
  return <DailyCompetition />;
}
