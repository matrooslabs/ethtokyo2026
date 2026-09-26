import { DocsLayout } from "@/components/docs/docsLayout";
import {
  gameplayTroubleshooting,
  proofTroubleshooting,
  walletTroubleshooting,
} from "@/components/docs/faqContent";
import { FaqSection } from "@/components/faq/faqSection";
import { createFileRoute } from "@tanstack/react-router";
import { Gamepad2, ScrollText, Wallet, Wrench } from "lucide-react";

export const Route = createFileRoute("/faq/troubleshooting")({
  component: TroubleshootingPage,
  head: () => ({
    meta: [
      { title: "Troubleshooting - osu! arena" },
      {
        name: "description",
        content:
          "Fixes for wallet, gameplay and proof issues in the osu! arena.",
      },
    ],
  }),
});

function TroubleshootingPage() {
  return (
    <DocsLayout
      icon={<Wrench className="size-5" />}
      eyebrow="TROUBLESHOOTING"
      title="Something not working?"
      intro="Fixes for wallet, gameplay and proof issues, grouped by where things go wrong."
    >
      <FaqSection
        title="Wallet & payment"
        description="Networks, approvals and entry"
        icon={<Wallet className="size-5" />}
        items={walletTroubleshooting}
      />
      <FaqSection
        title="Gameplay"
        description="Connection, input and audio"
        icon={<Gamepad2 className="size-5" />}
        items={gameplayTroubleshooting}
      />
      <FaqSection
        title="Proof & score"
        description="Failed proofs, missing scores and deadlines"
        icon={<ScrollText className="size-5" />}
        items={proofTroubleshooting}
      />
    </DocsLayout>
  );
}
