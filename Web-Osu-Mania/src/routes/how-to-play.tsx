import { DocsLayout } from "@/components/docs/docsLayout";
import { FOUR_KEYS } from "@/components/homeKeysGuide";
import { createFileRoute } from "@tanstack/react-router";

const coinLabel = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "USDC" : "test USDC";

export const Route = createFileRoute("/how-to-play")({
  component: HowToPlayPage,
  head: () => ({ meta: [
    { title: "How to play · versu!" },
    { name: "description", content: "Four keys, three plays per payment, one verified winner." },
  ] }),
});

function HowToPlayPage() {
  return (
    <DocsLayout title="How to play" intro="Press when notes meet the line.">
      <section id="controls" className="arena-guide scroll-mt-20">
        <h2>Four lanes</h2>
        <div className="arena-guide-keys">
          {FOUR_KEYS.map((lane, i) => <div key={lane.key}>
            <kbd>{lane.key}</kbd><span>Lane {i + 1}</span><small>{lane.finger}</small>
          </div>)}
        </div>
        <p>Tap short notes. Hold long notes until the tail. Press chords together.</p>
      </section>
      <section id="entry" className="arena-guide scroll-mt-20">
        <h2>Start a run</h2>
        <ol>
          <li>Connect the approved four-key controller on a desktop browser.</li>
          <li>Connect a Sui wallet and verify with World ID. Canceling verification takes no payment.</li>
          <li>Buy 3 plays for 1 {coinLabel}. Starting a run spends 1; leaving ends it.</li>
        </ol>
      </section>
      <section id="results" className="arena-guide scroll-mt-20">
        <h2>Win the pot</h2>
        <p>Finish a run and submit its signed score. Only scores verified on Sui rank. The top wallet gets the pot after the round.</p>
        <p>No device? You can still see the leaderboard or claim a prize. If nobody records a score, buyers can get a refund.</p>
      </section>
    </DocsLayout>
  );
}
