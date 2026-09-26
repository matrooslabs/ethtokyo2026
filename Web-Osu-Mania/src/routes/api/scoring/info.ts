import { createFileRoute } from "@tanstack/react-router";
import { relayScoring } from "@/server/suiScoring";

export const Route = createFileRoute("/api/scoring/info")({
  server: { handlers: { GET: ({ request }) => relayScoring(request, "info") } },
});
