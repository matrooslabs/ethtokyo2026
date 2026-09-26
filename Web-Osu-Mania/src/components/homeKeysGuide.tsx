export const FOUR_KEYS = [
  { key: "D", finger: "Left middle" },
  { key: "F", finger: "Left index" },
  { key: "J", finger: "Right index" },
  { key: "K", finger: "Right middle" },
] as const;

/** A compact controls reminder for the home competition, independent of game state. */
export function HomeKeysGuide() {
  return (
    <section className="arena-home-keys" aria-labelledby="arena-home-keys-title">
      <div className="arena-home-keys-copy">
        <h2 id="arena-home-keys-title" className="sr-only">How to play</h2>
        <p>Press at the line. Hold long notes.</p>
      </div>
      <div className="arena-home-keys-row" aria-label="Four lanes from left to right: D, F, J, K. Press at the hit line.">
        {FOUR_KEYS.map(({ key }, index) => (
          <div className="arena-home-lane" key={key}>
            <span className={`arena-home-note arena-home-note-${index}`} aria-hidden="true" />
            <span className="arena-home-hitline" aria-hidden="true" />
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
    </section>
  );
}
