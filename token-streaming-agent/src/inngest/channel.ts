import { channel, staticSchema } from "inngest/realtime";

// Shared contract between the worker (publisher) and the browser (subscriber).
// Both sides import this file, so the topic shapes can never drift apart.

// One `tokens` message is a small batch of streamed text for a single model
// turn. `seq` is a per-turn counter starting at 0 — the UI groups by `turn`
// and orders by `seq`, and treats a re-appearing `seq: 0` as a replay (the
// turn's step was retried, so its buffer should be reset and re-built).
export type TokenMessage = { turn: number; seq: number; delta: string };

// Lifecycle/status events, published durably (`step.realtime.publish`) so
// they survive worker restarts and are never duplicated or dropped.
export type StatusMessage =
  | { type: "run.started" }
  | { type: "tool.called"; turn: number; name: string; input: unknown }
  | { type: "tool.result"; turn: number; name: string; output: string }
  | { type: "turn.completed"; turn: number; text: string }
  | { type: "run.completed"; text: string }
  | { type: "run.failed"; error: string };

// One channel per chat session, with two topics: high-frequency token deltas
// and low-frequency lifecycle status. Subscribers pick a session by calling
// `chatChannel(sessionId)`.
export const chatChannel = channel({
  name: (sessionId: string) => `chat:${sessionId}`,
  topics: {
    tokens: { schema: staticSchema<TokenMessage>() },
    status: { schema: staticSchema<StatusMessage>() },
  },
});

// Client-owned chat history shape (see api/chat/route.ts) — this app has no
// server-side session store, so the browser sends the full transcript on
// every request.
export type ChatMessage = { role: "user" | "assistant"; content: string };
