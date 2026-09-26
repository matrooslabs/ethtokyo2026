import type { ReactNode } from "react";

export function DocsLayout({ title, intro, children }: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return <article className="arena-document mx-auto max-w-3xl px-6 py-12 md:py-16">
    <header className="mb-12 border-b pb-6">
      <h1 className="text-3xl md:text-4xl">{title}</h1>
      <p className="mt-3">{intro}</p>
    </header>
    <div className="flex flex-col gap-12">{children}</div>
  </article>;
}
