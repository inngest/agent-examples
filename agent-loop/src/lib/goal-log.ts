// A goal's log: everything that happened to it, in order. The goal only
// appends; what it needs (the best code, the reviewer's note, stalls, and what
// the brief and the reports show) is read off the log. The log is made of step
// results, so a replay rebuilds it exactly and it survives any restart.
import { grade, type Graded } from "../../check/grade.js";
import { JOURNAL_SIZE } from "../config.js";
import { excerpt, type AttemptOutcome } from "../inngest/channel.js";
import type { Files } from "./files.js";
import type { Focus, JournalEntry, Regressions } from "./prompt.js";

/** What the goal reads from an attempt (the coder's result). */
export type Attempt = {
  commit: string;
  files: Files;
  changed: boolean;
  summary: string;
  finished: boolean;
  turns: number;
  noToolCallTurns: number;
  usage: { input: number; output: number; usd?: number };
  // The ladder rung this attempt's acting replies needed, when above the start.
  rung?: number;
};

export type Attempted = {
  kind: "attempt";
  i: number;
  focus?: Focus;
  // Null when the attempt failed or was stopped.
  attempt: Attempt | null;
  result: Graded;
  outcome: AttemptOutcome;
  // Failing cases against the best before it, overall and per function.
  deltaFailed: number;
  delta?: Record<string, number>;
};

export type Entry =
  | { kind: "baseline"; result: Graded }
  // The best, re-scored because the grader changed under the goal (a deploy mid-goal).
  | { kind: "rescored"; i: number; result: Graded }
  | Attempted
  | Review;

/** A reviewer's message. `resumed` when it ended a wait for review; `timedOut` when none came (a stop). */
export type Review = { kind: "review"; i: number; note?: string; stop: boolean; resumed: boolean; timedOut?: boolean };

export type GoalLog = Entry[];

const isAttempt = (e: Entry): e is Attempted => e.kind === "attempt";
const wasKept = (e: Entry) => isAttempt(e) && e.outcome === "kept";

/** The attempts so far. */
export const attempts = (log: GoalLog): Attempted[] => log.filter(isAttempt);

/** The best code so far: the latest kept attempt, re-score or baseline. */
export function best(log: GoalLog): Graded {
  for (const e of log.toReversed()) {
    if (e.kind === "baseline" || e.kind === "rescored") return e.result;
    if (isAttempt(e) && e.outcome === "kept") return e.result;
  }
  throw new Error("a goal log starts with its baseline");
}

/** The latest reviewer's note, which every later brief carries. */
export function note(log: GoalLog): string | undefined {
  for (const e of log.toReversed()) {
    if (e.kind === "review" && e.note !== undefined) return e.note;
  }
  return undefined;
}

/** Whether a reviewer stopped the goal. */
export const stopped = (log: GoalLog): boolean => log.some((e) => e.kind === "review" && e.stop);

/** Attempts since the last kept one, or since the last review that ended a wait. */
export function stalls(log: GoalLog): number {
  const since = log.findLastIndex((e) => wasKept(e) || (e.kind === "review" && e.resumed));
  return log.slice(since + 1).filter(isAttempt).length;
}

function outcomeOf(attempt: Attempt | null, result: Graded, before: Graded): AttemptOutcome {
  if (!attempt) return "failed";
  if (!attempt.changed) return "unchanged";
  if (result.score < before.score) return "kept";
  return "reverted";
}

/** Attempt `i` as a log entry, compared with the best before it. */
export function attempted(i: number, attempt: Attempt | null, result: Graded, before: Graded, focus?: Focus): Attempted {
  const entry: Attempted = { kind: "attempt", i, focus, attempt, result, outcome: outcomeOf(attempt, result, before), deltaFailed: result.failed - before.failed };
  if (attempt?.changed && result.byFn && before.byFn) {
    entry.delta = Object.fromEntries(Object.entries(result.byFn).map(([fn, v]) => [fn, v.failed - (before.byFn?.[fn]?.failed ?? 0)]));
  }
  return entry;
}

/**
 * Checks attempt `i` against the best so far and says what happened, as log
 * entries. Unchanged code (or none) skips the check. A grader that changed
 * under the goal re-scores the best first, so the two scores compare; the
 * attempt's regressions were against the old grader, so they're dropped.
 */
export async function checkAttempt(
  grader: Parameters<typeof grade>[0],
  log: GoalLog,
  i: number,
  attempt: Attempt | null,
  focus?: Focus,
): Promise<Entry[]> {
  const before = best(log);
  if (!attempt?.changed) return [attempted(i, attempt, before, before, focus)];

  const result = await grade(grader, `check-${i}`, attempt, "train", before.failBits);
  if (result.checkVersion === before.checkVersion) return [attempted(i, attempt, result, before, focus)];

  const rescored = await grade(grader, `rebaseline-${i}`, before, "train");
  return [{ kind: "rescored", i, result: rescored }, attempted(i, attempt, { ...result, regressions: undefined }, rescored, focus)];
}

/** The last few attempts, for the brief: what each did and how it went. */
export const journal = (log: GoalLog): JournalEntry[] =>
  attempts(log)
    .slice(-JOURNAL_SIZE)
    .map((a) => ({
      i: a.i,
      outcome: a.outcome,
      failed: a.result.failed,
      summary: excerpt(a.attempt?.summary ?? "(the attempt failed)", 160),
      delta: a.delta,
    }));

/** The cases the last reverted attempt broke, until an attempt is kept. */
export function regressions(log: GoalLog): Regressions | undefined {
  for (const a of attempts(log).toReversed()) {
    if (a.outcome === "kept") return undefined;
    if (a.outcome === "reverted" && a.result.regressions?.count) return { i: a.i, ...a.result.regressions };
  }
  return undefined;
}

/** Per function, the focused attempts that weren't kept (see pickFocus). */
export function focusMisses(log: GoalLog): Record<string, number> {
  const misses: Record<string, number> = {};
  for (const a of attempts(log)) {
    if (a.focus && a.outcome !== "kept") misses[a.focus.fn] = (misses[a.focus.fn] ?? 0) + 1;
  }
  return misses;
}

/** What the attempts add up to. */
export function totals(log: GoalLog) {
  const all = attempts(log);
  const usage = { input: 0, output: 0, usd: 0 };
  for (const a of all) {
    usage.input += a.attempt?.usage.input ?? 0;
    usage.output += a.attempt?.usage.output ?? 0;
    usage.usd += a.attempt?.usage.usd ?? 0;
  }
  return {
    attempts: all.length,
    kept: all.filter(wasKept).length,
    bestAt: all.findLast(wasKept)?.i ?? 0,
    // The reasoning ladder's rung later attempts start on (src/models/openrouter.ts).
    startRung: Math.max(0, ...all.map((a) => a.attempt?.rung ?? 0)),
    usage,
  };
}
