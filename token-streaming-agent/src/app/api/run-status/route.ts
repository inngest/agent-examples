// Catch-up endpoint: given a chat run's triggering event id, ask Inngest for
// the run's status and output. Inngest Realtime has no replay, so when the
// browser misses a `run.completed` (a dropped connection, or a reload mid-run)
// this is how the client recovers the finished reply — see the polling in
// components/Chat.tsx. Keeps the server stateless: the source of truth is the
// Inngest run record, not a store of our own.
type RunStatus = "running" | "completed" | "failed" | "cancelled";

// Dev Server (no key) vs Inngest Cloud (signing key). Override explicitly with
// INNGEST_API_BASE_URL if a proxy sits in front of either.
const INNGEST_API_BASE =
  process.env.INNGEST_API_BASE_URL ??
  (process.env.INNGEST_SIGNING_KEY ? "https://api.inngest.com" : "http://localhost:8288");

export async function GET(req: Request) {
  const eventId = new URL(req.url).searchParams.get("eventId");
  if (!eventId) {
    return Response.json({ error: "Expected ?eventId=" }, { status: 400 });
  }

  try {
    const res = await fetch(`${INNGEST_API_BASE}/v1/events/${eventId}/runs`, {
      headers: process.env.INNGEST_SIGNING_KEY
        ? { Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}` }
        : {},
      // We're polling for a live transition — never serve a cached status.
      cache: "no-store",
    });

    // A 404 (or any non-OK) usually just means the event/run isn't registered
    // yet; report "running" so the client keeps polling rather than giving up.
    if (!res.ok) return Response.json({ status: "running" satisfies RunStatus });

    // `chat/message.sent` only triggers `chat-agent` (the deferred scorer runs
    // under a different trigger), so data[0] is the chat run. `output` is the
    // function's return value: { text, variant, model, newMessages }.
    const json = (await res.json()) as { data?: Array<{ status?: string; output?: unknown }> };
    const run = json.data?.[0];
    if (!run) return Response.json({ status: "running" satisfies RunStatus });

    if (run.status === "Completed") {
      return Response.json({ status: "completed" satisfies RunStatus, output: run.output });
    }
    // Cancelled is split out from Failed so the client can settle to a neutral
    // "stopped" state (no error banner) if it missed the live `run.cancelled`.
    if (run.status === "Cancelled") {
      return Response.json({ status: "cancelled" satisfies RunStatus });
    }
    if (run.status === "Failed") {
      return Response.json({ status: "failed" satisfies RunStatus });
    }
    return Response.json({ status: "running" satisfies RunStatus });
  } catch {
    // Network hiccup talking to Inngest — treat as still running so the client
    // retries instead of surfacing a spurious failure.
    return Response.json({ status: "running" satisfies RunStatus });
  }
}
