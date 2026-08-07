import { connect, ConnectionState } from "inngest/connect";
import { Hono } from "hono";
import { inngest } from "./inngest/client";
import { recordMessage } from "./inngest/functions";
import { feedbackScorer } from "./inngest/scorers";
import { waitForReply } from "./reply-bus";

// Functions registered over the connect socket — NOT via a /api/inngest serve
// endpoint. Inngest Cloud (or the Dev Server) pushes step invocations to this
// worker over a persistent WebSocket. Auto-syncs on connect; no manual sync.
const functions = [recordMessage, feedbackScorer];

const app = new Hono();

// The chat UI — single-file React app (see src/ui/index.html).
const UI_HTML = await Bun.file(`${import.meta.dir}/ui/index.html`).text();
app.get("/", (c) => c.html(UI_HTML));

// This app runs against Inngest Cloud (.env sets INNGEST_EVENT_KEY +
// INNGEST_SIGNING_KEY), so events and runs live in the Cloud REST API, not a
// local Dev Server. Switch on whether a signing key is configured: Cloud
// requires it as a bearer token; the Dev Server takes no auth at all.
const INNGEST_API_BASE =
  process.env.INNGEST_API_BASE_URL ??
  (process.env.INNGEST_SIGNING_KEY ? "https://api.inngest.com" : "http://localhost:8288");

// Diagnostic only. Replies are delivered in-process via the reply bus — the
// Cloud REST API doesn't expose run output, so it can't be the reply path —
// but when a reply never arrives, one status lookup distinguishes "the run
// failed" (502) from "the run is genuinely still going" (504).
async function fetchRunStatus(eventId: string): Promise<string | undefined> {
  const headers = process.env.INNGEST_SIGNING_KEY
    ? { Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}` }
    : undefined;
  try {
    const res = await fetch(`${INNGEST_API_BASE}/v1/events/${eventId}/runs`, { headers });
    const { data } = (await res.json()) as { data: Array<{ status: string }> };
    return data[0]?.status;
  } catch {
    return undefined;
  }
}

// Chat: send the triggering event, then wait for the record-message run
// (which makes the durable model call) to hand back its reply.
app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
  if (!body.prompt) {
    return c.json({ error: "missing 'prompt' in request body" }, 400);
  }

  const messageId = crypto.randomUUID();

  // Register the waiter BEFORE sending the event: the record-message run
  // executes in this same process (via Connect) and can finish fast enough to
  // beat an after-the-send registration.
  const pendingReply = waitForReply(messageId, 90_000);

  const { ids } = await inngest.send({
    name: "chat/message.requested",
    data: { prompt: body.prompt, messageId },
  });

  const result = await pendingReply;

  if (result) {
    return c.json({ reply: result.reply, variant: result.variant, messageId });
  }

  const status = await fetchRunStatus(ids[0]);
  if (status === "Failed" || status === "Cancelled") {
    return c.json({ error: `run ${status.toLowerCase()}` }, 502);
  }
  return c.json({ error: "timed out waiting for reply" }, 504);
});

// Thumbs up/down: send the event the deferred scorer is waiting on. Inngest
// matches it to the waiting scorer by messageId; the scorer resumes and
// records the score on the original record-message run.
app.post("/api/feedback", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    messageId?: string;
    up?: boolean;
  };
  if (!body.messageId || typeof body.up !== "boolean") {
    return c.json({ error: "missing 'messageId' or boolean 'up'" }, 400);
  }

  await inngest.send({
    name: "chat/feedback.clicked",
    data: { messageId: body.messageId, up: body.up },
  });

  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);

// Outbound persistent connection to Inngest. There is no /api/inngest route —
// the worker reaches out to Inngest, and step invocations are pushed down the
// socket. Long-running steps (like the deferred scorer's 1-day waitForEvent)
// aren't bound by HTTP timeouts.
const connection = await connect({
  apps: [{ client: inngest, functions }],
  // Identifies this worker instance for horizontal scaling and rolling deploys.
  // Defaults to hostname; in containers set this to the container id.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

// Readiness probe — returns 200 only when the connect socket is ACTIVE, so a
// load balancer routes traffic here only when the worker can run steps.
app.get("/ready", (c) =>
  connection.state === ConnectionState.ACTIVE
    ? c.text("OK", 200)
    : c.text("NOT OK", 500),
);

Bun.serve({ port, fetch: app.fetch });

console.log(`Worker: connected (${connection.state})`);
console.log(`Chat UI:  http://localhost:${port}`);

// Block until the connect socket gracefully closes (SIGTERM/SIGINT), then exit.
await connection.closed;
console.log("Worker: shut down");
process.exit(0);
