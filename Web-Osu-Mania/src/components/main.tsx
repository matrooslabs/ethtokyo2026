import { lazy, Suspense, useEffect, useState } from "react";
import { HomeKeysGuide } from "@/components/homeKeysGuide";
import DailyCompetition from "./leaderboard/dailyCompetition";

const DevCompetition = import.meta.env.MODE === "development" ? lazy(() => import("./dev/devCompetition")) : null;

export default function Main() {
  const [internalSimulation, setInternalSimulation] = useState(false);
  useEffect(() => {
    const sync = () => setInternalSimulation(window.location.hash === "#_simulation");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  if ((import.meta.env.VITE_BEATMAP_URL && import.meta.env.VITE_BEATMAP_URL !== "/beatmaps/forest.osz") ||
      (import.meta.env.DEV && import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL &&
        import.meta.env.VITE_DEVELOPMENT_BEATMAP_URL !== "/beatmaps/forest.osz")) {
    return <div className="arena-loading" role="alert">
      <h1>Play four keys.</h1>
      <HomeKeysGuide />
      <p>Forest archive is not configured. Set VITE_BEATMAP_URL=/beatmaps/forest.osz.</p>
    </div>;
  }
  if (import.meta.env.MODE === "development" && import.meta.env.VITE_VERSU_MODE === "dev" && internalSimulation && DevCompetition) {
    return <Suspense fallback={<p role="status">Loading local simulation…</p>}><DevCompetition /></Suspense>;
  }
  return <DailyCompetition />;
}
