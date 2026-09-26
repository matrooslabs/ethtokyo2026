import { Footer } from "@/components/footer";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const DOC_GROUPS = [
  {
    title: "GUIDE",
    pages: [{ to: "/how-to-play", label: "How to play" }],
  },
  {
    title: "FAQ",
    pages: [
      { to: "/faq", label: "Overview" },
      { to: "/faq/general", label: "FAQ" },
      { to: "/faq/security", label: "Security model" },
      { to: "/faq/troubleshooting", label: "Troubleshooting" },
    ],
  },
] as const;

export function DocsLayout({
  icon,
  eyebrow,
  title,
  intro,
  children,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="arena-document">
      <div className="border-border/50 border-b">
        <div className="mx-auto max-w-5xl px-6 py-16 md:py-20">
          <div className="flex max-w-2xl flex-col gap-4">
            <div className="text-primary flex items-center gap-2">
              {icon}
              <span className="text-sm tracking-widest">{eyebrow}</span>
            </div>
            <h1 className="text-3xl tracking-tight md:text-4xl">{title}</h1>
            <p className="text-muted-foreground text-pretty md:text-lg">
              {intro}
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-12 md:py-16">
        <div className="grid gap-12 md:grid-cols-[200px_1fr] md:gap-16">
          <aside>
            <nav className="arena-docs-nav sticky top-24 flex flex-col gap-6">
              {DOC_GROUPS.map((group) => (
                <div key={group.title} className="flex flex-col gap-1">
                  <span className="text-muted-foreground mb-2 text-xs tracking-widest">
                    {group.title}
                  </span>
                  {group.pages.map((page) => (
                    <Link
                      key={page.to}
                      to={page.to}
                      activeProps={{ className: "active" }}
                      activeOptions={{ exact: true }}
                      className="text-muted-foreground hover:bg-secondary hover:text-foreground px-3 py-1.5 text-sm transition-colors"
                    >
                      {page.label}
                    </Link>
                  ))}
                </div>
              ))}
            </nav>
          </aside>
          <div className="flex flex-col gap-14">{children}</div>
        </div>
      </div>

      <Footer />
    </div>
  );
}
