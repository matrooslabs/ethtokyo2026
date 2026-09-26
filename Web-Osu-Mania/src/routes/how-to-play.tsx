import { DocsLayout } from "@/components/docs/docsLayout";
import { FOUR_KEYS } from "@/components/homeKeysGuide";
import { createFileRoute } from "@tanstack/react-router";

const coinLabel = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "USDC" : "test USDC";

export const Route = createFileRoute("/how-to-play")({
  component: HowToPlayPage,
  head: () => ({ meta: [
    { title: "How to play · versu!" },
    { name: "description", content: "Play Forest of Clock Easy or Hard with four keys. Verified players share one six-hour challenge pot." },
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
        <h2>Choose your chart</h2>
        <ol>
          <li>Choose Forest of Clock Easy or Hard. Both charts share one six-hour challenge.</li>
          <li>Connect the approved controller and your Sui wallet. A run starts only while enough time remains to finish and submit its proof.</li>
          <li>Buy 3 shared play credits for 1 {coinLabel}, then set your speed. Each paid start spends 1 credit on either chart, even if the run is interrupted.</li>
        </ol>
      </section>
      <section id="results" className="arena-guide scroll-mt-20">
        <h2>Claim a share</h2>
        <p>Submit your controller-signed score before the six-hour deadline. Easy and Hard have separate verified standings, but all purchases fund one pot: 30% for Easy and 70% for Hard. Each chart pays its top five eligible players 40%, 20%, 20%, 10%, 10% of that chart’s slice.</p>
        <p>After scoring closes, verify with World ID to claim one wallet on one chart. Unclaimed shares return to the buyers; they do not increase a winner’s share.</p>
      </section>
    </DocsLayout>
  );
}
