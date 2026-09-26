import { createFileRoute } from "@tanstack/react-router";
import { verify } from "@/server/worldIdentity";

export const Route = createFileRoute("/api/identity/verify")({
  server: { handlers: { POST: ({ request }) => verify(request) } },
});
