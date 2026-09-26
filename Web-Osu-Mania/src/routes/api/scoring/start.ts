import { createFileRoute } from "@tanstack/react-router";
import { relayScoring } from "@/server/suiScoring";

export const Route = createFileRoute("/api/scoring/start")({
  server: { handlers: { POST: ({ request }) => relayScoring(request, "start") } },
});
