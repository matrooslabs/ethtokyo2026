import { DocsLayout } from "@/components/docs/docsLayout";
import { competitionFaq } from "@/components/docs/faqContent";
import { FaqSection } from "@/components/faq/faqSection";
import { createFileRoute } from "@tanstack/react-router";
import { Coins } from "lucide-react";

export const Route = createFileRoute("/faq/general")({
  component: FaqPage,
  head: () => ({
    meta: [
      { title: "FAQ - osu! arena" },
      {
        name: "description",
        content: "Payments, attempts, deadlines and payouts in the osu! arena.",
      },
    ],
  }),
});

function FaqPage() {
  return (
    <DocsLayout
      icon={<Coins className="size-5" />}
      eyebrow="FAQ"
      title="Questions about the pot."
      intro="Payments, repeat attempts, deadlines, ties and payouts, answered."
    >
      <FaqSection
        title="Competition"
        description="Payments, attempts, deadlines and payouts"
        icon={<Coins className="size-5" />}
        items={competitionFaq}
      />
    </DocsLayout>
  );
}
