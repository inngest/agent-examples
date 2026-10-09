import { channel, staticSchema } from "inngest/realtime";
import type OpenAI from "openai";

// Shared contract between the worker (publisher) and the browser (subscriber).
// Both sides import this file, so the topic shapes can never drift apart.

// One `tokens` message is a small batch of streamed text for a single model
// turn. `seq` is a per-turn counter starting at 0 — the UI groups by `turn`
// and orders by `seq`, and treats a re-appearing `seq: 0` as a replay (the
// turn's step was retried, so its buffer should be reset and re-built).
export type TokenMessage = { turn: number; seq: number; delta: string };

// Snapshot of context-window occupancy after one model turn. `inputTokens`
// covers the system prompt, tools, and full history; adding `outputTokens`
// gives what the conversation occupies right now. `contextWindow` and
// `maxTokens` (the per-response output cap) both come from the worker so the
// UI can draw the meter — reserving `maxTokens` from `contextWindow` — with no
// model knowledge of its own.
export type ContextUsage = {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  maxTokens: number;
};

// Lifecycle/status events, published durably (`step.realtime.publish`) so
// they survive worker restarts and are never duplicated or dropped.
export type StatusMessage =
  // Carries which experiment variant/model this run picked (sticky per
  // session) so the UI can show what model is currently answering.
  | { type: "run.started"; variant: string; model: string }
  | { type: "tool.called"; turn: number; name: string; input: unknown }
  | { type: "tool.result"; turn: number; name: string; output: string }
  | { type: "turn.completed"; turn: number; text: string; usage: ContextUsage }
  // `newMessages` are the exact API messages the run appended (assistant
  // turns with tool_use blocks + user tool_result messages), which the
  // client stores and replays on the next request so the model keeps tool
  // context across messages instead of just the plain-text transcript.
  | { type: "run.completed"; text: string; newMessages: ChatMessage[] }
  | { type: "run.failed"; error: string }
  // Published when a run is cancelled via the Stop button (`cancelOn`). Distinct
  // from `run.failed` so the UI settles to a neutral "stopped" state, not an
  // error. Carries no text — a cancelled run has no durable final answer; the
  // client keeps whatever partial text it already streamed.
  | { type: "run.cancelled" };

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
// every request. It's the OpenAI/OpenRouter Chat Completions message shape so a
// stored assistant turn can carry its `tool_calls` and the following `tool`
// messages can carry their results — otherwise a follow-up request would replay
// history with all tool context erased. The worker prepends the system message
// itself, so this transcript never includes a system turn. The import is
// type-only, so the client bundle doesn't pull in the SDK runtime.
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
