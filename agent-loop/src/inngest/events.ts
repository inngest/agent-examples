import { eventType } from "inngest";
import { z } from "zod";

// v4 event schemas can't use transforms (input type must equal output type),
// so .default() is not allowed here. Optional fields + the DEFAULTS below are
// applied by the goal-loop function instead.
export const GOAL_DEFAULTS = {
  maxAttempts: 60,
  maxStalls: 5,
  maxTurnsPerAttempt: 8,
  reasoningEffort: "low",
  maxTokensPerTurn: 8000,
  reasoningMaxTokens: 2048,
} as const;

export const goalStarted = eventType("goal/started", {
  schema: z.object({
    goalId: z.string().min(1),
    model: z.string().min(1),
    maxAttempts: z.number().int().positive().optional(), // default 60
    maxStalls: z.number().int().positive().optional(), // default 5
    maxTurnsPerAttempt: z.number().int().positive().optional(), // default 8
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(), // default "low"
    maxTokensPerTurn: z.number().int().positive().optional(), // default 8000
    reasoningMaxTokens: z.number().int().positive().optional(), // default 2048; takes precedence over reasoningEffort
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
    costUsd: z.number(),
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
