//
import Main from "@/components/main";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

const indexSearchSchema = z.object({
  q: z.string().optional(),
  stars: z.string().optional(),
});

export const Route = createFileRoute("/")({
  component: Home,
  validateSearch: zodValidator(indexSearchSchema),
});

function Home() {
  return (
    <div className="arena-shell">
      <Main />
    </div>
  );
}
