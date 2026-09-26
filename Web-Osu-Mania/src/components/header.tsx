import { Link } from "@tanstack/react-router";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export default function Header() {
  return (
    <header className="arena-header">
      <Link
        to="/"
        onClick={() => window.dispatchEvent(new Event("arena:home"))}
        className="arena-brand"
        aria-label="osu! arena home"
      >
        <span className="arena-logo">osu!</span>
        <strong>osu! arena</strong>
        <span className="arena-tag">ETH TOKYO</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link
          to="/"
          onClick={() => window.dispatchEvent(new Event("arena:home"))}
          activeProps={{ className: "active" }}
        >
          Leaderboard
        </Link>
        <Link to="/faq">How to play</Link>
        <ConnectButton
          accountStatus="address"
          chainStatus="none"
          showBalance={false}
        />
      </nav>
    </header>
  );
}
