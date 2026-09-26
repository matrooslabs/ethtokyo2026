import { createFileRoute } from "@tanstack/react-router";
import { attest } from "@/server/worldIdentity";

export const Route = createFileRoute("/api/identity/attest")({
  server: { handlers: { POST: ({ request }) => attest(request) } },
});
