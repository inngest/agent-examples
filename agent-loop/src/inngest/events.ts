// The events this app sends and receives:
//   goal/started           goal:send / goal:watch: starts a goal (one thread per goalId)
//   goal/review.submitted  goal:watch: a note or a stop, into the goal's inbox at any time
//   goal/attempt.scored    the goal, once per attempt
//   goal/finished          the goal, once at the end
// The last three are also how goal:watch rebuilds a goal's history (src/lib/goal-history.ts).
// And the coder's input, `attemptRequested`: what the goal starts each attempt with.
import { eventType, invoke } from "inngest";
import { z } from "zod";

// --- the coder's input ---

export const attemptRequested = invoke(
  z.object({
    goalId: z.string(),
    i: z.number(),
    // What the model reads: the brief, with the starting code inlined.
    brief: z.string(),
    // The code the attempt starts from: the best so far. Sent every time, so a
    // sandbox recreated after a restart starts from the right code.
    files: z.record(z.string(), z.string()),
    maxTurns: z.number(),
    model: z.object({
      slug: z.string(),
      maxTokensPerTurn: z.number(),
      maxTokensCap: z.number(),
      supportsReasoning: z.boolean(),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
      reasoningMaxTokens: z.number().optional(),
      // The reasoning-ladder rung to start on (src/models/openrouter.ts).
      startRung: z.number().optional(),
    }),
  }),
);

// The brief experiment (see src/agents/goal.ts and scripts/eval.ts). What each
// variant changes is written out where it runs.
export const VARIANT_NAMES = ["control", "spec", "examples", "no_focus"] as const;
export type BriefVariant = (typeof VARIANT_NAMES)[number];

// --- inbound: start and steer a goal ---

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
    focus: z.boolean().optional(), // default true: each attempt works on one failing function
    spec: z.boolean().optional(), // default false: include Go's documentation (data/spec.txt) in the brief
    examplesPerBrief: z.number().int().positive().max(50).optional(), // default 10; with a focus, drawn from that function's cases
    variant: z.enum(VARIANT_NAMES).optional(), // run the "brief" experiment with this fixed variant; its options override focus/spec/examplesPerBrief
  }),
});

export const goalReviewSubmitted = eventType("goal/review.submitted", {
  schema: z.object({
    goalId: z.string().min(1),
    action: z.enum(["continue", "stop"]),
    note: z.string().optional(),
  }),
});

// --- outbound: what the loop records ---

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
    summary: z.string().optional(), // what the attempt says it did (work_finish), clipped
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
    variant: z.string().optional(), // the brief variant, when the run had one
  }),
});
