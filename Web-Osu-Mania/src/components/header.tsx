import { Link, useRouterState } from "@tanstack/react-router";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export default function Header() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <header className="arena-header">
      <Link
        to="/"
        onClick={() => window.dispatchEvent(new Event("arena:home"))}
        className="arena-brand"
      >
        <img
          className="arena-logo"
          src={`${import.meta.env.BASE_URL}favicon-96x96.png`}
          alt=""
          width="40"
          height="40"
          aria-hidden="true"
        />
        <strong>osu! arena</strong>
        <span className="arena-tag" aria-hidden="true">
          ETH TOKYO
        </span>
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
        <Link
          to="/faq"
          className={pathname.startsWith("/faq") ? "active" : undefined}
        >
          FAQ
        </Link>
        <ConnectButton
          accountStatus="address"
          chainStatus="none"
          showBalance={false}
        />
      </nav>
    </header>
  );
}
