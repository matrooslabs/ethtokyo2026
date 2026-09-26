import { createFileRoute } from "@tanstack/react-router";
import { relayScoring } from "@/server/suiScoring";

export const Route = createFileRoute("/api/scoring/jobs/$sessionId/retry")({
  server: { handlers: { POST: ({ request, params }) => relayScoring(request, "retry", params.sessionId) } },
});
