// What goal-loop carries from attempt to attempt, and the one pure function
// that updates it after each attempt. Pure, and fed only memoized results
// (the invoke, the check steps), so a replay rebuilds exactly the same state.
import type { CheckResult } from "../../check/types.js";
import type { AttemptResult } from "../inngest/agent-attempt.js";
import { excerpt, type AttemptOutcome } from "../inngest/channel.js";
import type { Files } from "./backend.js";
import type { Focus, JournalEntry, Regressions } from "./prompt.js";
import type { LadderStart } from "./reasoning-ladder.js";

// In the sandbox backend there's no git: the best result carries the files
// themselves (step state is the only storage).
export type Best = CheckResult & { files?: Files };

/** Recent attempts shown to the next one (see buildBrief). */
export const JOURNAL_SIZE = 5;

export type LoopState = {
  best: Best;
  // Attempts since the last kept one (or the last review).
  stalls: number;
  humanNote?: string;
  journal: JournalEntry[];
  // What the last reverted attempt broke; cleared once one is kept.
  regressions?: Regressions;
  // Per function, focused attempts that weren't kept (see pickFocus).
  focusMisses: Record<string, number>;
  // Where earlier attempts' reasoning ladders ended up; only grows.
  learned: LadderStart;
  costUsd: number;
  tokens: { input: number; output: number };
};

export const initialState = (baseline: Best): LoopState => ({
  best: baseline,
  stalls: 0,
  journal: [],
  focusMisses: {},
  learned: {},
  costUsd: 0,
  tokens: { input: 0, output: 0 },
});

/** Stands in for an attempt that failed or returned nothing: a no-change stall. */
export const failedAttempt = (best: Best, summary: string): AttemptResult => ({
  commit: best.commit,
  changed: false,
  files: best.files,
  summary,
  turns: 0,
  idleTurns: 0,
  tokens: { input: 0, output: 0 },
  finished: false,
  costUsd: 0,
  failed: true,
});

export function classify(attempt: AttemptResult, result: CheckResult, best: Best): AttemptOutcome {
  if (!attempt.changed) return attempt.failed ? "failed" : "unchanged";
  return result.score < best.score ? "kept" : "reverted";
}

/**
 * The loop state after one attempt. `result` is the attempt's check (the best
 * itself when it changed nothing); `rebaselined` is the incumbent re-scored
 * when the check changed in between, so both sides are under one version.
 */
export function afterAttempt(
  state: LoopState,
  a: { i: number; attempt: AttemptResult; result: CheckResult; focus?: Focus; rebaselined?: CheckResult },
): { state: LoopState; outcome: AttemptOutcome } {
  const { i, attempt, result, focus } = a;
  // Regressions were computed against the old best's failBits; they're only
  // meaningful if the check didn't change in between.
  const checkedAgainstVersion = state.best.checkVersion;
  const best: Best = a.rebaselined ? { ...a.rebaselined, files: state.best.files } : state.best;
  const outcome = classify(attempt, result, best);

  // Per-function change against the best before this attempt.
  const delta =
    attempt.changed && result.byFn && best.byFn
      ? Object.fromEntries(Object.entries(result.byFn).map(([fn, v]) => [fn, v.failed - (best.byFn?.[fn]?.failed ?? 0)]))
      : undefined;
  const journal = [
    ...state.journal,
    { i, outcome, failed: result.failed, summary: excerpt(attempt.summary, 160), ...(delta ? { delta } : {}) },
  ].slice(-JOURNAL_SIZE);

  const focusMisses =
    focus && outcome !== "kept" ? { ...state.focusMisses, [focus.fn]: (state.focusMisses[focus.fn] ?? 0) + 1 } : state.focusMisses;

  let regressions = state.regressions;
  if (outcome === "kept") regressions = undefined;
  else if (outcome === "reverted" && result.checkVersion === checkedAgainstVersion && result.regressions?.count)
    regressions = { i, count: result.regressions.count, examples: result.regressions.examples };

  const learned = attempt.learned
    ? {
        maxTokens: Math.max(state.learned.maxTokens ?? 0, attempt.learned.maxTokens),
        reasoningOff: state.learned.reasoningOff || attempt.learned.reasoningOff,
      }
    : state.learned;

  const kept = outcome === "kept";
  return {
    outcome,
    state: {
      ...state,
      best: kept ? { ...result, files: attempt.files } : best,
      stalls: kept ? 0 : state.stalls + 1,
      journal,
      regressions,
      focusMisses,
      learned,
      costUsd: state.costUsd + attempt.costUsd,
      tokens: { input: state.tokens.input + attempt.tokens.input, output: state.tokens.output + attempt.tokens.output },
    },
  };
}
