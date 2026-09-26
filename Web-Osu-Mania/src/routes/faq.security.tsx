import { DocsLayout } from "@/components/docs/docsLayout";
import { advancedSecurityFaq, securityFaq } from "@/components/docs/faqContent";
import { FaqSection } from "@/components/faq/faqSection";
import { createFileRoute } from "@tanstack/react-router";
import { FlaskConical, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/faq/security")({
  component: SecurityPage,
  head: () => ({
    meta: [
      { title: "Security model - osu! arena" },
      {
        name: "description",
        content:
          "What the osu! arena assumes, why, and how each attack scenario fails.",
      },
    ],
  }),
});

function SecurityPage() {
  return (
    <DocsLayout
      icon={<ShieldCheck className="size-5" />}
      eyebrow="SECURITY MODEL"
      title="Trust the math, not us."
      intro="What we assume, why we assume it, and how each attack scenario fails."
    >
      <FaqSection
        title="Security model"
        description="Assumptions and attack scenarios, question by question"
        icon={<ShieldCheck className="size-5" />}
        items={securityFaq}
      />
      <FaqSection
        title="Advanced questions"
        description="Proof-system trade-offs, alternative designs and their adversary models"
        icon={<FlaskConical className="size-5" />}
        items={advancedSecurityFaq}
      />
    </DocsLayout>
  );
}
