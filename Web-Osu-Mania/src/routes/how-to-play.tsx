import { DocsLayout } from "@/components/docs/docsLayout";
import { FOUR_KEYS } from "@/components/homeKeysGuide";
import { createFileRoute } from "@tanstack/react-router";

const coinLabel = "USDC";

export const Route = createFileRoute("/how-to-play")({
  component: HowToPlayPage,
  head: () => ({ meta: [
    { title: "How to play · versu!" },
    { name: "description", content: "Play Forest of Clock Easy or Hard with four keys. Verified players share one six-hour challenge pot." },
  ] }),
});

function HowToPlayPage() {
  return (
    <DocsLayout title="How to play" intro="D F J K at the hit line.">
      <section id="controls" className="arena-guide scroll-mt-20">
        <h2>Four lanes</h2>
        <div className="arena-guide-keys">
          {FOUR_KEYS.map((lane, i) => <div key={lane.key}>
            <kbd>{lane.key}</kbd><span>Lane {i + 1}</span><small>{lane.finger}</small>
          </div>)}
        </div>
        <p>Tap notes, hold long notes, press chords together.</p>
      </section>
      <section id="entry" className="arena-guide scroll-mt-20">
        <h2>Play</h2>
        <ol>
          <li>Connect the Bridge controller. Practice the four-note demo for free; practice scores do not rank.</li>
          <li>For paid play, choose Forest of Clock Easy or Hard and connect a Sui wallet.</li>
          <li>1 {coinLabel} buys 3 starts on either chart. Each start spends 1, even if interrupted. Submit the signed score before the six-hour cutoff.</li>
        </ol>
      </section>
      <section id="results" className="arena-guide scroll-mt-20">
        <h2>Claim</h2>
        <p>Easy gets 30% and Hard 70% of the shared pot. Each chart’s top five eligible claims split its slice 40/20/20/10/10%.</p>
        <p>After scoring closes, use World ID for one claim per person. Missing shares return to buyers.</p>
      </section>
    </DocsLayout>
  );
}
