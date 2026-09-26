import { createFileRoute } from "@tanstack/react-router";
import { relayScoring } from "@/server/suiScoring";

export const Route = createFileRoute("/api/scoring/submit")({
  server: { handlers: { POST: ({ request }) => relayScoring(request, "submit") } },
});
