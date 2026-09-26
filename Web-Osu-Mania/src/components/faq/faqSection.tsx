import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { faqId, type FaqItem } from "@/components/docs/faqContent";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

export function FaqSection({
  icon,
  title,
  description,
  items,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  items: FaqItem[];
}) {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [open, setOpen] = useState("");
  useEffect(() => {
    const id = (hash || window.location.hash).replace(/^#/, "");
    if (!items.some((item) => faqId(item.question) === id)) return;
    setOpen(id);
    requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView({ block: "center" }),
    );
  }, [hash, items]);

  return (
    <section className="relative">
      <div className="mb-6 flex items-center gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
          {icon}
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
      </div>

      <div className="border-border/60 bg-card rounded-xl border">
        <Accordion
          type="single"
          collapsible
          value={open}
          onValueChange={setOpen}
          className="w-full divide-y"
        >
          {items.map((item) => (
            <AccordionItem
              key={item.question}
              id={faqId(item.question)}
              value={faqId(item.question)}
              className="scroll-mt-24 px-6"
            >
              <AccordionTrigger className="hover:text-primary py-5 text-left font-medium tracking-tight hover:no-underline">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground pb-5 leading-relaxed">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
