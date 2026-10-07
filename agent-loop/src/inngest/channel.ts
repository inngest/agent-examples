import { channel, staticSchema } from "inngest/realtime";

// Shared contract between the worker (goal-loop and agent-attempt publish) and
// `pnpm goal:watch` (subscribes). Realtime has no history, so the watcher
// rebuilds the past from the REST events API (src/lib/goal-history.ts) and
// uses this channel only for what happens while it's open.

// What the loop decided about one attempt. `outcome` is the keep/revert
// verdict; `bestScore` and `stalls` are the loop state after it.
export type AttemptOutcome = "kept" | "reverted" | "unchanged" | "failed";
export type ScoredMessage = {
  type: "attempt.scored";
  i: number;
  score: number;
  failed: number;
  total: number;
  changed: boolean;
  turns: number;
  idleTurns: number;
  costUsd: number;
  outcome: AttemptOutcome;
  bestScore: number;
  stalls: number;
  summary?: string;
};

export type LoopMessage =
  | { type: "goal.started"; model: string; maxAttempts: number; maxStalls: number; baseline: { failed: number; total: number; score: number } }
  | ScoredMessage
  // `report` is the best attempt's check report (what still fails), so the
  // reviewer can see what to say.
  | { type: "review.waiting"; i: number; stalls: number; bestScore: number; report: string }
  | { type: "review.resumed"; i: number; action: "continue" | "stop" | "timeout"; note?: string }
  // The goal can't run (e.g. the model can't call tools); the run fails.
  | { type: "goal.failed"; reason: string }
  | {
      type: "goal.finished";
      attempts: number;
      costUsd: number;
      best: { failed: number; total: number; score: number };
      holdout: { failed: number; total: number; score: number; pass: boolean };
    };

// Live detail of the attempt in flight: one message per model turn and per
// tool call. `text` is a short excerpt of what the model said, if anything.
export type AttemptMessage =
  | { type: "attempt.started"; i: number }
  // `inputTokens` is the whole prompt this turn (system, brief, history), i.e.
  // how much of the context window the attempt is using; `provider` is who
  // served it (OpenRouter).
  | {
      type: "turn";
      i: number;
      t: number;
      toolCalls: number;
      finishReason: string;
      text: string;
      outputTokens: number;
      reasoningTokens?: number; // of outputTokens
      maxTokens?: number; // this turn's output budget (the reasoning ladder may raise it)
      reasoningOff?: boolean; // the ladder turned reasoning off
      inputTokens?: number;
      provider?: string;
    }
  | { type: "tool"; i: number; t: number; n: number; name: string; result: string }
  | { type: "finish.refused"; i: number; t: number };

// One channel per goal; the watcher subscribes to both topics.
export const goalChannel = channel({
  name: (goalId: string) => `goal:${goalId}`,
  topics: {
    loop: { schema: staticSchema<LoopMessage>() },
    attempt: { schema: staticSchema<AttemptMessage>() },
  },
});

export const excerpt = (s: string | null | undefined, max = 160) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
