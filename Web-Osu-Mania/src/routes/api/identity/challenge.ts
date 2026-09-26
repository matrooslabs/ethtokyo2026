import { createFileRoute } from "@tanstack/react-router";
import { challenge } from "@/server/worldIdentity";

export const Route = createFileRoute("/api/identity/challenge")({
  server: { handlers: { POST: ({ request }) => challenge(request) } },
});
