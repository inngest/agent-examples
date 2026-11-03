// What a goal tells the world: the TUI's live view, the events the TUI
// rebuilds its history from (and the eval scripts read), and the scores. Each
// report is one step, so a replay never repeats it; its event has a fixed id,
// so a retried step doesn't send it twice.
import { step } from "inngest";
import { score } from "inngest/experimental/agents";
import type { CheckResult } from "../../check/types.js";
import { inngest } from "../inngest/client.js";
import { excerpt, goalChannel, type LoopMessage } from "../inngest/channel.js";
import { goalAttemptScored, goalFinished } from "../inngest/events.js";
import { attempts, best, stalls, totals, type GoalLog } from "./goal-log.js";

const scoreOf = (r: CheckResult) => ({ failed: r.failed, total: r.total, score: r.score });

function reviewAction(review: { stop: boolean; timedOut?: boolean }): "continue" | "stop" | "timeout" {
  if (review.timedOut) return "timeout";
  if (review.stop) return "stop";
  return "continue";
}

export function reporter(goal: { goalId: string; runId: string; model: string; maxAttempts: number; maxStalls: number; variant?: string }) {
  const { goalId, runId } = goal;
  const live = (msg: LoopMessage) => inngest.realtime.publish(goalChannel(goalId).loop, msg).catch(() => {});
  const report = (id: string, fn: () => Promise<unknown>) => step.run(`report-${id}`, async () => (await fn(), null));

  return {
    failed: (reason: string) => report("failed", () => live({ type: "goal.failed", reason })),

    started: (log: GoalLog) =>
      report("started", () =>
        live({ type: "goal.started", model: goal.model, maxAttempts: goal.maxAttempts, maxStalls: goal.maxStalls, baseline: scoreOf(best(log)) }),
      ),

    /** The goal's latest attempt. */
    attempt: (log: GoalLog) => {
      const { i, attempt, result, outcome, deltaFailed } = attempts(log).at(-1)!;
      const facts = {
        ...scoreOf(result),
        changed: attempt?.changed ?? false,
        turns: attempt?.turns ?? 0,
        idleTurns: attempt?.noToolCallTurns ?? 0,
        costUsd: attempt?.usage.usd ?? 0,
        summary: excerpt(attempt?.summary ?? "(the attempt failed)", 200),
      };
      return report(`attempt-${i}`, async () => {
        await live({ type: "attempt.scored", i, ...facts, outcome, bestScore: best(log).score, stalls: stalls(log) });
        await inngest.send({
          ...goalAttemptScored.create({
            goalId,
            i,
            ...facts,
            checkVersion: result.checkVersion,
            commit: result.commit,
            model: goal.model,
            tokens: { input: attempt?.usage.input ?? 0, output: attempt?.usage.output ?? 0 },
            finished: attempt?.finished ?? false,
            report: result.report,
          }),
          id: `${runId}-scored-${i}`,
        });
        await score({
          "check.fail_rate": result.score,
          "attempt.pass_rate": 1 - result.score,
          "attempt.delta_failed": deltaFailed,
          "attempt.kept": outcome === "kept",
          "attempt.turns": facts.turns,
          "attempt.idle_turns": facts.idleTurns,
          "attempt.cost_usd": facts.costUsd,
        });
      });
    },

    waiting: (log: GoalLog, i: number) =>
      report(`waiting-${i}`, () => live({ type: "review.waiting", i, stalls: stalls(log), bestScore: best(log).score, report: best(log).report })),

    resumed: (i: number, review: { stop: boolean; note?: string; timedOut?: boolean }) =>
      report(`resumed-${i}`, () => live({ type: "review.resumed", i, action: reviewAction(review), note: review.note })),

    /** The final scores, goal/finished, and the goal's output. */
    finished: async (log: GoalLog, holdout: CheckResult) => {
      const final = best(log);
      const { attempts, kept, bestAt, usage } = totals(log);
      const output = {
        best: { commit: final.commit, ...scoreOf(final) },
        holdout: { commit: holdout.commit, ...scoreOf(holdout), pass: holdout.pass },
        attempts,
        costUsd: usage.usd,
        tokens: { input: usage.input, output: usage.output },
      };
      await report("finished", async () => {
        await live({ type: "goal.finished", ...output });
        await inngest.send({ ...goalFinished.create({ goalId, ...output, variant: goal.variant }), id: `${runId}-finished` });
        await score({
          "train.pass_rate": 1 - final.score,
          "holdout.pass_rate": 1 - holdout.score,
          generalization_gap: holdout.score - final.score,
          solved: holdout.pass,
          attempts,
          kept_attempts: kept,
          best_at_attempt: bestAt,
          cost_usd: usage.usd,
          tokens_total: usage.input + usage.output,
          ...Object.fromEntries(Object.entries(final.byFn ?? {}).map(([fn, v]) => [`fn.${fn}.pass_rate`, 1 - v.failed / Math.max(v.total, 1)])),
        });
      });
      return output;
    },
  };
}
