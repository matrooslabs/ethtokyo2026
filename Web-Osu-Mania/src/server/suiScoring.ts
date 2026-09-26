import { env } from "cloudflare:workers";

type ScoringEnv = { SUI_SCORING_ORIGIN?: string; SUI_SCORING_API_TOKEN?: string };
const sessionPattern = /^0x[0-9a-fA-F]{64}$/;

export async function relayScoring(request: Request, action: "start" | "submit" | "job" | "retry" | "info", sessionId?: string): Promise<Response> {
  const { SUI_SCORING_ORIGIN: origin, SUI_SCORING_API_TOKEN: token } = env as ScoringEnv;
  if (!origin || !token || !/^https:\/\//.test(origin) && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    return Response.json({ error: "Scoring service is not configured for this deployment." }, { status: 503 });
  }
  if ((action === "job" || action === "retry") && (!sessionId || !sessionPattern.test(sessionId))) {
    return Response.json({ error: "Invalid session ID." }, { status: 400 });
  }
  const path = action === "info" ? "/v1/info" : action === "job" ? `/v1/jobs/${sessionId}` : action === "retry" ? `/v1/jobs/${sessionId}/retry` : `/v1/sessions/${action}`;
  if ((action === "start" || action === "submit") && (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") || 0) > 3_000_000)) {
    return Response.json({ error: "Expected a bounded JSON request." }, { status: 400 });
  }
  try {
    const content = action === "start" || action === "submit" ? await request.text() : undefined;
    if (content && new TextEncoder().encode(content).length > 3_000_000) {
      return Response.json({ error: "Signed trace request is too large." }, { status: 413 });
    }
    const response = await fetch(`${origin.replace(/\/$/, "")}${path}`, {
      method: action === "job" || action === "info" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(content ? { "Content-Type": "application/json" } : {}) },
      body: content,
      signal: AbortSignal.timeout(25_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Scoring service unavailable; the spent play cannot be resumed." }, { status: 503 });
  }
}
