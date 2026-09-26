import { DocsLayout } from "@/components/docs/docsLayout";
import { createFileRoute } from "@tanstack/react-router";
import { Gamepad2 } from "lucide-react";

const LANES = [
  { key: "D", finger: "Left middle" },
  { key: "F", finger: "Left index" },
  { key: "J", finger: "Right index" },
  { key: "K", finger: "Right middle" },
];

const JUDGEMENTS = [
  { name: "PERFECT", window: "±19.5 ms", points: 320 },
  { name: "GREAT", window: "±49.5 ms", points: 300 },
  { name: "GOOD", window: "±82.5 ms", points: 200 },
  { name: "OK", window: "±112.5 ms", points: 100 },
  { name: "MEH", window: "±136.5 ms", points: 50 },
  { name: "MISS", window: "outside", points: 0 },
];

export const Route = createFileRoute("/how-to-play")({
  component: HowToPlayPage,
  head: () => ({
    meta: [
      { title: "How to play - osu! arena" },
      {
        name: "description",
        content:
          "How to play osu!mania 4K and how a round in the osu! arena works.",
      },
    ],
  }),
});

function HowToPlayPage() {
  return (
    <DocsLayout
      icon={<Gamepad2 className="size-5" />}
      eyebrow="HOW TO PLAY"
      title="Four keys. One song. One pot."
      intro="Controls, scoring and how a round works."
    >
      <section id="how-to-play" className="arena-guide scroll-mt-20">
        <h2>How to play osu!mania 4K</h2>
        <p>
          Notes fall down four lanes. Press the lane's key when a note reaches
          the judgement line at the bottom.
        </p>

        <h3>Controls</h3>
        <div className="arena-guide-keys">
          {LANES.map((lane, i) => (
            <div key={lane.key}>
              <kbd>{lane.key}</kbd>
              <span>Lane {i + 1}</span>
              <small>{lane.finger}</small>
            </div>
          ))}
        </div>
        <p>
          You can change the keys in the keybinds tab. On a touchscreen, tap the
          lanes.
        </p>

        <h3>Note types</h3>
        <ul>
          <li>
            <b>Tap</b>: press once.
          </li>
          <li>
            <b>Hold</b>: press at the head and release at the tail.
          </li>
          <li>
            <b>Chord</b>: press several lanes at the same time.
          </li>
        </ul>
      </section>

      <section id="scoring" className="arena-guide scroll-mt-20">
        <h2>Scoring</h2>
        <p>The closer you hit to the beat, the more points you get.</p>
        <div className="arena-guide-table">
          <table>
            <thead>
              <tr>
                <th>Judgement</th>
                <th>Hit within</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody>
              {JUDGEMENTS.map((j) => (
                <tr key={j.name}>
                  <td>{j.name}</td>
                  <td>{j.window}</td>
                  <td>{j.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <code>Score = your points ÷ max points × 1,000,000</code>. All PERFECT
          scores 1,000,000. A hold note is scored twice, once for the press and
          once for the release.
        </p>
      </section>

      <section id="arena-flow" className="arena-guide scroll-mt-20">
        <h2>A round in the arena</h2>
        <ol>
          <li>
            <b>Connect</b> a wallet with the browser extension or the
            WalletConnect QR code on your phone.
          </li>
          <li>
            <b>Pay 1 USDC</b>. The entry and the game session are created in the
            same transaction.
          </li>
          <li>
            <b>Play</b> today's 4K beatmap from start to finish.
          </li>
          <li>
            <b>Prove</b>. The scorer builds a GKR proof from your input log and
            submits it. You can follow its progress on screen.
          </li>
          <li>
            <b>Rank</b>. Once the contract accepts it, your score counts for the
            day. Your best attempt is the one that stays.
          </li>
          <li>
            <b>Claim</b>. After 00:00 UTC the top wallet takes the whole pot.
          </li>
        </ol>
      </section>
    </DocsLayout>
  );
}
