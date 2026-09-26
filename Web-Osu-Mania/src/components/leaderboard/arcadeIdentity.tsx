/** Original pixel geometry; no template artwork or additional dependencies. */
export function ArcadeMedal() {
  return (
    <svg
      className="arena-pixel-medal"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path d="M6 1h12v2h3v3h2v12h-2v3h-3v2H6v-2H3v-3H1V6h2V3h3V1Zm1 3v2H5v12h2v2h10v-2h2V6h-2V4H7Z" />
      <path d="M7 9h2v6H7zm4-3h2v12h-2zm4 3h2v6h-2z" />
    </svg>
  );
}

export function ArcadeCreditLine() {
  return (
    <div className="arena-credit-line">
      <span className="arena-key-motif" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>4 KEYS. ONE TOP SPOT.</span>
    </div>
  );
}

export function ArcadeLobbyBar() {
  return (
    <div className="arena-lobby-bar">
      <span>ETH TOKYO / RHYTHM ARCADE</span>
      <span>ONE BEATMAP · DAILY COMPETITION</span>
    </div>
  );
}
