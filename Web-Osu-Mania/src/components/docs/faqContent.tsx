import type { ReactNode } from "react";

export interface FaqItem {
  question: string;
  answer: ReactNode;
}

export function faqId(question: string) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function Answer({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}

function Scenario({
  attack,
  defense,
}: {
  attack: ReactNode;
  defense: ReactNode;
}) {
  return (
    <div className="border-border border-l-2 pl-4">
      <p>
        <b className="text-foreground">Scenario:</b> {attack}
      </p>
      <p>
        <b className="text-foreground">What stops it:</b> {defense}
      </p>
    </div>
  );
}

export const competitionFaq: FaqItem[] = [
  {
    question: "How much does it cost and where does the money go?",
    answer: (
      <p>
        Every attempt costs exactly 1 USDC. The payment goes straight into the
        smart contract that holds that day's pot for that beatmap. Nobody,
        including the organizer, can withdraw it. At the end of the UTC day the
        whole pot goes to the first-place wallet.
      </p>
    ),
  },
  {
    question: "Can I play more than once?",
    answer: (
      <p>
        Yes. Each attempt is a separate 1 USDC entry. The contract keeps only
        your best verified score for the day, and every attempt adds to the pot.
      </p>
    ),
  },
  {
    question: "Can I pay from my phone?",
    answer: (
      <p>
        Yes. Choose WalletConnect in the connect dialog and scan the QR code
        with your mobile wallet. You approve the payment on your phone, then
        play on the computer. A browser extension wallet works too.
      </p>
    ),
  },
  {
    question: "When does the day end, and how do I claim?",
    answer: (
      <Answer>
        <p>
          A day is a UTC day, taken from the block timestamp. Your payment and
          your verified score must both land before the next 00:00 UTC. New
          entries close early enough to leave time for the song and for proof
          generation.
        </p>
        <p>
          After midnight the claim opens. No one has to finalize anything first.
          Anyone can send the transaction, and the pot always goes to the
          winning wallet.
        </p>
      </Answer>
    ),
  },
  {
    question: "What happens with ties or if nobody scores?",
    answer: (
      <p>
        If two scores tie, the one accepted on-chain first wins. A score of 0
        still counts as a score. If no one gets a verified score that day, every
        payer can get their own payments for that day back.
      </p>
    ),
  },
  {
    question: "The leaderboard looks stale. Is my score lost?",
    answer: (
      <p>
        No. The leaderboard list comes from an indexer that reads contract
        events, and it can fall behind. The contract is the source of truth.
        Claims and refunds read the contract directly and still work while the
        indexer is down.
      </p>
    ),
  },
];

export const securityFaq: FaqItem[] = [
  {
    question: "Why prove scores at all instead of trusting a game server?",
    answer: (
      <Answer>
        <p>
          Real money is at stake, and the winner takes everything. If a server
          could just report a score, whoever runs that server could decide the
          winner. So we don't trust the server, the organizer or the browser. We
          trust only what the contract can check for itself.
        </p>
        <p>
          The scorer turns your key-press log into a GKR/sumcheck proof that the
          judgement counts were computed correctly from that log and the
          registered beatmap. The contract verifies the proof and then works out
          MISS and the final score itself.
        </p>
        <Scenario
          attack="A compromised scoring server submits a million points for a friend."
          defense="Without a valid proof over a real input log, the verifier rejects it. The server can refuse to relay your play, but it cannot invent one."
        />
      </Answer>
    ),
  },
  {
    question: "Why not just verify the whole replay on-chain?",
    answer: (
      <Answer>
        <p>
          A song can produce tens of thousands of key events. Replaying the
          judgement rules for each event in the EVM would cost too much gas. A
          GKR proof is cheap to check no matter how long the song is.
        </p>
        <p>
          In committed mode, the full trace is also left out of calldata. The
          contract sees only a hash root and a KZG commitment to the trace, and
          the proof is tied to both.
        </p>
      </Answer>
    ),
  },
  {
    question: "Can the organizer pick the winner or take the pot?",
    answer: (
      <Answer>
        <p>
          No. That is a design rule. The payment token, fee and verifier
          registry are fixed, and the contract has no function for the organizer
          to withdraw funds or choose a winner.
        </p>
        <Scenario
          attack="The organizer wants to redirect the pot to their own wallet after the day ends."
          defense="The pot can only go to the best verified score. If there is no score, it goes back to the payers as refunds. No other path exists."
        />
        <p>
          The organizer can still register beatmaps and input devices, and can
          revoke a device. Those are the trust assumptions we accept, and they
          are visible on-chain.
        </p>
      </Answer>
    ),
  },
  {
    question:
      "What stops someone from editing the game client or faking inputs?",
    answer: (
      <Answer>
        <p>
          This is the most important limit. A proof shows that the score matches
          the input log. It cannot show that a human made that log. A modified
          browser or a bot can generate perfect key presses, and they would
          prove correctly.
        </p>
        <p>
          That is why a signed input device is part of the model. The device
          records key edges with its own microsecond clock. It hashes and
          commits to every event as it happens. At the end it signs the session
          header together with the trace root. It will not sign any digest that
          a host sends it. The contract accepts only traces signed by a
          registered, unrevoked device.
        </p>
        <Scenario
          attack="A macro script sends perfectly timed key events to the browser."
          defense="With hardware capture, browser events are ignored. Only the switch presses the device timed and signed itself can be scored."
        />
      </Answer>
    ),
  },
  {
    question: "Can a good score be replayed or reused?",
    answer: (
      <Answer>
        <p>
          No. Each paid attempt opens a session that is bound to the payer,
          player, beatmap, day and device. The device signs over that session,
          and the session is marked as consumed as soon as a submission
          succeeds.
        </p>
        <Scenario
          attack="Resubmit yesterday's best proof, or someone else's, into today's round."
          defense="The session ID, day and player inside the signed header won't match, and a consumed session is rejected."
        />
        <Scenario
          attack="Submit a score for a session nobody paid for."
          defense="Payment and session creation happen in one transaction. An unpaid session cannot enter the pot."
        />
      </Answer>
    ),
  },
  {
    question: "What about submitting a score right after midnight?",
    answer: (
      <Scenario
        attack="Wait until the winner is known, then land a better score for the closed day."
        defense="The contract rejects any score for a day at or after the next UTC midnight, and each session also has an expiry. Once the day closes, the result is final."
      />
    ),
  },
  {
    question: "What if the indexer or the scoring server goes down?",
    answer: (
      <Answer>
        <Scenario
          attack="The indexer is hacked and shows a fake leader."
          defense="The indexer is only for display. Claims read the contract, which ignores the indexer entirely."
        />
        <Scenario
          attack="The scorer crashes in the middle of a proof."
          defense="The job is saved to disk. It can be generated again for the same paid session, and any transaction that was already submitted is checked again instead of being sent twice."
        />
      </Answer>
    ),
  },
  {
    question: "What does this demo not guarantee yet?",
    answer: (
      <Answer>
        <p>This is a hackathon build, so here are the known limits:</p>
        <ul className="list-disc pl-5">
          <li>
            Software demo mode signs with a software key, so it does not prove
            that a human physically played.
          </li>
          <li>
            The proofs use a development SRS whose secret is publicly known.
            This is fine for a demo but not sound for production.
          </li>
          <li>
            The scoring and relayer service is built for a single user on
            loopback, not for public multi-user hosting.
          </li>
        </ul>
        <p>
          Each of these can be swapped out on its own: a certified device, a
          ceremony-generated SRS and an authenticated relayer. The contract
          rules stay the same.
        </p>
      </Answer>
    ),
  },
];

export const walletTroubleshooting: FaqItem[] = [
  {
    question: "My wallet asks me to switch networks.",
    answer: (
      <p>
        The arena runs on Ethereum Sepolia. Accept the switch prompt. If no
        prompt appears, switch your wallet to Sepolia yourself and try again.
      </p>
    ),
  },
  {
    question: "Why are there two wallet prompts?",
    answer: (
      <p>
        The first prompt lets the contract spend 1 USDC. The second one pays the
        entry. Setup opens once the entry is confirmed.
      </p>
    ),
  },
  {
    question: "My transaction failed. Did I lose 1 USDC?",
    answer: (
      <p>
        No. A reverted transaction moves no USDC; you only pay gas. If entries
        closed while you were approving, no entry payment was made either.
      </p>
    ),
  },
  {
    question: "The phone QR code doesn't show up.",
    answer: (
      <p>
        This deployment may not have WalletConnect set up. If you see "Phone QR
        is not configured", connect with a browser wallet instead.
      </p>
    ),
  },
  {
    question: "Entries are closed, but it isn't midnight yet.",
    answer: (
      <p>
        That's expected. Entries close early so the song and the proof can
        finish before 00:00 UTC. Come back for the next round.
      </p>
    ),
  },
];

export const gameplayTroubleshooting: FaqItem[] = [
  {
    question: 'It says "Competition connection unavailable".',
    answer: (
      <p>
        The site can't reach the contract or the scoring server right now.
        Practice still works, and paid entry comes back once the connection
        does.
      </p>
    ),
  },
  {
    question: "My keys don't respond.",
    answer: (
      <p>
        Click the game once so it has keyboard focus, and close any browser
        popups. Then check the 4K row in the keybinds tab. Keys are matched by
        physical position, so your keyboard layout doesn't matter.
      </p>
    ),
  },
  {
    question: "The notes feel off-beat.",
    answer: (
      <p>
        Bluetooth headphones add audio delay. Use wired audio or your device's
        speakers. Scoring is fixed and has no offset setting.
      </p>
    ),
  },
  {
    question: "I paused or closed the tab during a paid run.",
    answer: (
      <p>
        Pausing ends a paid run, and the entry stays in the pot. Keep the tab
        open and in focus until the song ends.
      </p>
    ),
  },
  {
    question: "Is there touchscreen or gamepad support?",
    answer: (
      <p>
        Yes. On a touchscreen, tap the lanes. For a gamepad, set its buttons in
        the keybinds tab before you play.
      </p>
    ),
  },
  {
    question: "The built-in beatmap isn't loading!",
    answer: (
      <p>
        Reload the page and check that your connection can fetch the bundled
        beatmap archive. No external beatmap providers are required.
      </p>
    ),
  },
];

export const proofTroubleshooting: FaqItem[] = [
  {
    question: "Proof generation failed.",
    answer: (
      <p>
        Press <b>Retry proof</b>. Your attempt is saved in the browser, so you
        don't have to play again. Keep the page open until the score is
        accepted.
      </p>
    ),
  },
  {
    question: "My score isn't on the leaderboard.",
    answer: (
      <p>
        The leaderboard list can lag behind the chain. Press{" "}
        <b>Submit / recheck proof</b> to check the contract directly. If it says
        the score was accepted, it counts.
      </p>
    ),
  },
  {
    question: "Midnight passed while my proof was running.",
    answer: (
      <p>
        Recheck the job. If the transaction landed before 00:00 UTC, the score
        counts. If not, check the round for the payout or a refund.
      </p>
    ),
  },
  {
    question: 'It says "Browser storage is full".',
    answer: (
      <p>
        Your attempt can't be saved for recovery. Don't close or reload the page
        until the proof is submitted.
      </p>
    ),
  },
];

export const troubleshootingFaq: FaqItem[] = [
  ...walletTroubleshooting,
  ...gameplayTroubleshooting,
  ...proofTroubleshooting,
];

function Compare({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="arena-guide-table">
      <table>
        <thead>
          <tr>
            {rows[0].map((cell) => (
              <th key={cell}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Adversary({
  who,
  breaks,
  verdict,
}: {
  who: ReactNode;
  breaks: ReactNode;
  verdict: ReactNode;
}) {
  return (
    <div className="border-border border-l-2 pl-4">
      <p>
        <b className="text-foreground">Adversary:</b> {who}
      </p>
      <p>
        <b className="text-foreground">How it breaks:</b> {breaks}
      </p>
      <p>
        <b className="text-foreground">Verdict:</b> {verdict}
      </p>
    </div>
  );
}

export const advancedSecurityFaq: FaqItem[] = [
  {
    question: "Why GKR + sumcheck + Zeromorph instead of SP1?",
    answer: (
      <Answer>
        <p>
          Speed. SP1 (our v1) took minutes per proof, which is too slow for a 1
          USDC game with a midnight deadline. Same 3,000-note play, same
          machine:
        </p>
        <Compare
          rows={[
            ["", "SP1 → Groth16", "GKR + Zeromorph"],
            ["Prove time", "287.8 s (27 GB RAM)", "~1.6 s"],
            ["Verify gas", "~0.30M", "~2.36M"],
            ["Proof size", "356 B", "27.8 KB"],
            ["Rule changes", "Edit Rust", "Redesign circuit"],
          ]}
        />
        <p>
          <b className="text-foreground">Trade-off:</b> about 180× faster
          proofs, but about 8× more gas and a custom circuit that hasn't been
          audited. Zeromorph needs only a universal powers-of-tau setup and is
          verified with the EVM's native BN254 pairings.
        </p>
      </Answer>
    ),
  },
  {
    question: "Why not just score in Solidity?",
    answer: (
      <Answer>
        <p>
          <b className="text-foreground">Floating point:</b> osu! timing uses
          doubles, and the EVM has no floats. Emulating them costs hundreds of
          gas per operation, and a one-bit rounding difference at a window edge
          can change the winner. So we fixed the rules as integer microseconds.
        </p>
        <p>
          <b className="text-foreground">Gas:</b> a replay has to process every
          event, up to 50,000. Just rechecking the trace hash, with no scoring
          at all, already costs 8.38M gas at 3,000 notes. A GKR proof check
          stays at about 2.1–2.4M no matter how long the song is.
        </p>
      </Answer>
    ),
  },
  {
    question: "Why not score in a TEE (cloud enclave) and post the result?",
    answer: (
      <Answer>
        <p>
          <b className="text-foreground">Garbage in, attested garbage out.</b>{" "}
          The enclave scores whatever log the browser sends, so a bot still gets
          a genuine attestation.
        </p>
        <p>
          <b className="text-foreground">The trust shifts to a vendor.</b> If
          one leaked enclave key signs fake scores, nothing on-chain can tell
          them from real ones. The operator can also hold back rivals' runs
          before midnight.
        </p>
        <p>
          Our hardware signs only raw key presses, never a score, and the
          scoring stays publicly provable.
        </p>
      </Answer>
    ),
  },
  {
    question: "Why not let a committee of judges sign scores?",
    answer: (
      <Adversary
        who="k of n colluding judges."
        breaks="They agree on a fake score, or go offline at midnight."
        verdict="Spreading trust across judges doesn't remove it. The judges also can't tell whether a human made the input."
      />
    ),
  },
  {
    question: "Why not optimistic scoring with fraud proofs?",
    answer: (
      <Adversary
        who="A cheater, plus watchers who stay silent."
        breaks="Post a fake score, then withhold the trace or wait out the challenge window."
        verdict="Every score needs a challenge window, which pushes payouts past midnight. It also needs at least one honest watcher. That doesn't fit a daily round."
      />
    ),
  },
  {
    question: "If the proof is valid, why isn't the browser log enough?",
    answer: (
      <Adversary
        who="Any player with a script."
        breaks="A bot creates a perfect key log, and the proof over it is completely honest."
        verdict="A proof shows the score is correct. It doesn't show a human played. That's why real money needs a signed input device."
      />
    ),
  },
  {
    question: "Can the signed input device still be beaten?",
    answer: (
      <Adversary
        who="A player who extracts the device key, or builds a robot."
        breaks="Sign synthetic events with a stolen key, or physically press the switches with a machine."
        verdict="A stolen key only affects one device, which can be revoked. A physical robot is the remaining limit, the same as at an arcade cabinet."
      />
    ),
  },
  {
    question: "Could the organizer still rig it?",
    answer: (
      <Adversary
        who="The organizer."
        breaks="Register a rigged beatmap or device, or open sessions only for friends."
        verdict="Every such action shows up on-chain, and none of them can move the pot. Beatmap bytes are checked on-chain against their commitment."
      />
    ),
  },
  {
    question: "What if someone knows the SRS secret?",
    answer: (
      <Adversary
        who="Anyone who knows τ, the SRS trapdoor."
        breaks="Forge a proof of any score."
        verdict="The demo's development SRS has a known τ. Production must use a public ceremony such as Perpetual Powers of Tau, which is safe if any one of its contributors was honest."
      />
    ),
  },
];
