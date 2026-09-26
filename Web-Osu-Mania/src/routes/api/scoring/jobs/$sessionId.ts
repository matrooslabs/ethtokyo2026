import { createFileRoute } from "@tanstack/react-router";
import { relayScoring } from "@/server/suiScoring";

export const Route = createFileRoute("/api/scoring/jobs/$sessionId")({
  server: { handlers: { GET: ({ request, params }) => relayScoring(request, "job", params.sessionId) } },
});
