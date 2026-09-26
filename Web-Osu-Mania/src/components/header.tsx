import { Link } from "@tanstack/react-router";

export default function Header() {
  return (
    <header className="arena-header">
      <Link
        to="/"
        onClick={() => window.dispatchEvent(new Event("arena:home"))}
        className="arena-brand"
      >
        <span className="arena-brand-mark" aria-hidden="true">
          <img
            className="arena-logo"
            src={`${import.meta.env.BASE_URL}versu-logo.png`}
            alt=""
            width="1536"
            height="1024"
          />
        </span>
        <strong>versu!</strong>
      </Link>
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
