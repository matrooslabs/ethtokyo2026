import { DocsLayout } from "@/components/docs/docsLayout";
import {
  advancedSecurityFaq,
  competitionFaq,
  faqId,
  securityFaq,
  troubleshootingFaq,
  type FaqItem,
} from "@/components/docs/faqContent";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Coins,
  HelpCircle,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";

export const Route = createFileRoute("/faq/")({
  component: FaqHub,
  head: () => ({
    meta: [
      { title: "FAQ - osu! arena" },
      {
        name: "description",
        content:
          "Key questions about the osu! arena: the prize pot, the security model and troubleshooting.",
      },
    ],
  }),
});

type HubSection = {
  to: "/faq/general" | "/faq/security" | "/faq/troubleshooting";
  icon: ReactNode;
  title: string;
  description: string;
  total: number;
  key: { item: FaqItem; short: string }[];
};

const pick = (items: FaqItem[], question: string) => {
  const item = items.find((i) => i.question === question);
  if (!item) throw new Error(`Missing FAQ item: ${question}`);
  return item;
};

const SECTIONS: HubSection[] = [
  {
    to: "/faq/general",
    icon: <Coins className="size-5" />,
    title: "FAQ",
    description: "Payments, attempts, deadlines and payouts",
    total: competitionFaq.length,
    key: [
      {
        item: pick(
          competitionFaq,
          "How much does it cost and where does the money go?",
        ),
        short:
          "1 USDC per attempt goes into the contract. The top wallet takes the whole daily pot.",
      },
      {
        item: pick(
          competitionFaq,
          "When does the day end, and how do I claim?",
        ),
        short:
          "The round closes at 00:00 UTC. After that, anyone can send the pot to the winner.",
      },
      {
        item: pick(
          competitionFaq,
          "What happens with ties or if nobody scores?",
        ),
        short:
          "The score accepted first wins a tie. If nobody scores, every payer gets a refund.",
      },
    ],
  },
  {
    to: "/faq/security",
    icon: <ShieldCheck className="size-5" />,
    title: "Security model",
    description: "What we assume, and how each attack fails",
    total: securityFaq.length + advancedSecurityFaq.length,
    key: [
      {
        item: pick(
          securityFaq,
          "Why prove scores at all instead of trusting a game server?",
        ),
        short:
          "The contract verifies a GKR proof, so no server can make up a score.",
      },
      {
        item: pick(
          securityFaq,
          "Can the organizer pick the winner or take the pot?",
        ),
        short:
          "No. The contract has no withdraw function and no way to choose a winner.",
      },
      {
        item: pick(
          advancedSecurityFaq,
          "If the proof is valid, why isn't the browser log enough?",
        ),
        short:
          "A proof checks the math, not the player. That's why a signed input device is needed.",
      },
      {
        item: pick(
          advancedSecurityFaq,
          "Why GKR + sumcheck + Zeromorph instead of SP1?",
        ),
        short:
          "Proofs are about 180× faster, and each one costs about 8× the gas.",
      },
    ],
  },
  {
    to: "/faq/troubleshooting",
    icon: <Wrench className="size-5" />,
    title: "Troubleshooting",
    description: "Wallet, gameplay and proof issues",
    total: troubleshootingFaq.length,
    key: [
      {
        item: pick(
          troubleshootingFaq,
          "My transaction failed. Did I lose 1 USDC?",
        ),
        short: "No. A reverted transaction moves no USDC. You only pay gas.",
      },
      {
        item: pick(troubleshootingFaq, "Proof generation failed."),
        short: "Press Retry proof. Your attempt is saved, so you don't replay.",
      },
      {
        item: pick(troubleshootingFaq, "My score isn't on the leaderboard."),
        short:
          "The list can lag. Recheck the proof to read the contract directly.",
      },
    ],
  },
];

function FaqHub() {
  return (
    <DocsLayout
      icon={<HelpCircle className="size-5" />}
      eyebrow="FAQ"
      title="Got questions?"
      intro="The key answers are on this page. Open any question for the full explanation, or browse a section."
    >
      {SECTIONS.map((section) => (
        <section key={section.to} className="arena-hub-card">
          <Link to={section.to} className="arena-hub-head">
            <span className="arena-hub-icon">{section.icon}</span>
            <span>
              <h2>{section.title}</h2>
              <small>{section.description}</small>
            </span>
            <ArrowRight className="size-5 shrink-0" />
          </Link>
          <ul>
            {section.key.map(({ item, short }) => (
              <li key={item.question}>
                <Link to={section.to} hash={faqId(item.question)}>
                  <b>{item.question}</b>
                  <span>{short}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link to={section.to} className="arena-hub-more">
            See all {section.total} questions <ArrowRight className="size-4" />
          </Link>
        </section>
      ))}
    </DocsLayout>
  );
}
