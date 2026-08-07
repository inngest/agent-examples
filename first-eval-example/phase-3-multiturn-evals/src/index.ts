import { connect, ConnectionState } from "inngest/connect";
import { Hono } from "hono";
import { inngest } from "./inngest/client";
import { recordMessage } from "./inngest/functions";
import { feedbackScorer, judgeScorer } from "./inngest/scorers";
import { captureDataset } from "./inngest/capture";
import type { ChatMessage } from "./openrouter";
import { waitForReply } from "./reply-bus";

// Functions registered over the connect socket — NOT via a /api/inngest serve
// endpoint. Inngest Cloud (or the Dev Server) pushes step invocations to this
// worker over a persistent WebSocket. Auto-syncs on connect; no manual sync.
const functions = [recordMessage, feedbackScorer, judgeScorer, captureDataset];

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

const MAX_MESSAGES = 40;

// Validates the client-supplied transcript before it's turned into a trigger
// event: must be a non-empty array of well-formed {role, content} turns,
// ending on a user turn (otherwise there's nothing for the model to reply
// to), and capped so a runaway client can't send an unbounded conversation
// into the model call.
function validateMessages(body: unknown): { messages: ChatMessage[] } | { error: string } {
  if (typeof body !== "object" || body === null || !("messages" in body)) {
    return { error: "missing 'messages' in request body" };
  }

  const { messages } = body as { messages: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "'messages' must be a non-empty array" };
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: `'messages' must contain at most ${MAX_MESSAGES} entries` };
  }

  for (const [i, entry] of messages.entries()) {
    const role = typeof entry === "object" && entry !== null ? (entry as { role?: unknown }).role : undefined;
    const content = typeof entry === "object" && entry !== null ? (entry as { content?: unknown }).content : undefined;
    const roleOk = role === "user" || role === "assistant";
    const contentOk = typeof content === "string" && content.trim() !== "";
    if (!roleOk || !contentOk) {
      return { error: `messages[${i}] must be {role: "user"|"assistant", content: <non-empty string>}` };
    }
  }

  const last = messages[messages.length - 1] as ChatMessage;
  if (last.role !== "user") {
    return { error: "the last message must have role 'user'" };
  }

  return { messages: messages as ChatMessage[] };
}

// Chat: send the triggering event, then wait for the record-message run
// (which makes the durable model call) to finish and return its output. The
// client sends the full visible transcript on every request — each assistant
// reply is its own scored record-message run, and conversationId just lets
// those runs be grouped back into one conversation in a dashboard query.
app.post("/api/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validated = validateMessages(body);
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }

  const { messages } = validated;
  const messageId = crypto.randomUUID();
  const conversationId =
    typeof (body as { conversationId?: unknown }).conversationId === "string"
      ? (body as { conversationId: string }).conversationId
      : crypto.randomUUID();

  // Register the waiter BEFORE sending the event: the record-message run
  // executes in this same process (via Connect) and can finish fast enough to
  // beat an after-the-send registration.
  const pendingReply = waitForReply(messageId, 90_000);

  const { ids } = await inngest.send({
    name: "chat/message.requested.v3",
    data: { messages, messageId, conversationId },
  });

  const result = await pendingReply;

  if (result) {
    return c.json({
      reply: result.reply,
      variant: result.variant,
      messageId,
      conversationId,
    });
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
    name: "chat/feedback.clicked.v3",
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
