import { Link } from "@tanstack/react-router";
import { useChallengeClockStore } from "@/stores/challengeClockStore";

export default function Header() {
  const { deadlineMs, nowMs, phase, simulated } = useChallengeClockStore();
  const seconds = Math.max(0, Math.ceil(((deadlineMs ?? nowMs) - nowMs) / 1000));
  const countdown = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <header className="arena-header">
      <Link
        to="/"
        onClick={() => window.dispatchEvent(new Event("arena:home"))}
        className="arena-brand"
      >
        <span className="arena-brand-mark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}versu-logo.png`} alt="" width="1536" height="1024" />
        </span>
        <strong>versu!</strong>
      </Link>
      {phase && <div className="arena-nav-clock" role="timer">
        <span>{simulated ? "Demo " : ""}{phase === "upcoming" ? "Starts in" : phase === "scoring" ? "Scores close" : "Claims close"}</span>
        <strong>{countdown}</strong>
      </div>}
      <nav aria-label="Main navigation">
        <Link
          to="/"
          onClick={() => window.dispatchEvent(new Event("arena:home"))}
          activeProps={{ className: "active" }}
        >
          Leaderboard
        </Link>
        <Link to="/how-to-play" activeProps={{ className: "active" }}>
          How to play
        </Link>
      </nav>
    </header>
  );
}
