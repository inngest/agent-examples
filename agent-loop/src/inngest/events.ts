import { eventType } from "inngest";
import { z } from "zod";

// v4 event schemas can't use transforms (input type must equal output type),
// so .default() is not allowed here. Optional fields + the DEFAULTS below are
// applied by the goal-loop function instead.
export const GOAL_DEFAULTS = {
  maxAttempts: 60,
  maxStalls: 5,
  maxTurnsPerAttempt: 8,
  maxTokensPerTurn: 4000,
} as const;

// Used when neither the event nor the MODEL env var names a model.
export const DEFAULT_MODEL = "qwen/qwen3-coder-30b-a3b-instruct";

export const goalStarted = eventType("goal/started", {
  schema: z.object({
    goalId: z.string().min(1),
    model: z.string().min(1).optional(), // default: MODEL env on the worker
    maxAttempts: z.number().int().positive().optional(), // default 60
    maxStalls: z.number().int().positive().optional(), // default 5
    maxTurnsPerAttempt: z.number().int().positive().optional(), // default 8
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(), // opt-in, thinking models only
    maxTokensPerTurn: z.number().int().positive().optional(), // default 4000
    reasoningMaxTokens: z.number().int().positive().optional(), // opt-in, thinking models only; takes precedence over reasoningEffort
  }),
});

export const goalReviewSubmitted = eventType("goal/review.submitted", {
  schema: z.object({
    goalId: z.string().min(1),
    action: z.enum(["continue", "stop"]),
    note: z.string().optional(),
  }),
});

export const goalAttemptScored = eventType("goal/attempt.scored", {
  schema: z.object({
    goalId: z.string(),
    i: z.number(),
    score: z.number(),
    failed: z.number(),
    total: z.number(),
    checkVersion: z.string(),
    commit: z.string(),
    model: z.string(),
    tokens: z.object({ input: z.number(), output: z.number() }),
    changed: z.boolean(),
    finished: z.boolean(),
    turns: z.number(),
    idleTurns: z.number(), // turns that ended without a tool call
    costUsd: z.number(),
    summary: z.string().optional(), // what the attempt says it did (finish_attempt), clipped
    report: z.string().optional(), // the check report for this result (what still fails)
  }),
});

export const goalFinished = eventType("goal/finished", {
  schema: z.object({
    goalId: z.string(),
    best: z.object({
      commit: z.string(),
      failed: z.number(),
      total: z.number(),
      score: z.number(),
    }),
    holdout: z.object({
      commit: z.string(),
      failed: z.number(),
      total: z.number(),
      score: z.number(),
      pass: z.boolean(),
    }),
    attempts: z.number(),
    costUsd: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
  }),
});
