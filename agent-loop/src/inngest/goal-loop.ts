import { inngest } from "./client.js";
import { agentAttempt } from "./agent-attempt.js";
import { DEFAULT_MODEL, GOAL_DEFAULTS, goalAttemptScored, goalFinished, goalReviewSubmitted, goalStarted } from "./events.js";
import { runCheck } from "../../check/run-check.js";
import { runCheckSandbox } from "../../check/run-check-sandbox.js";
import type { CaseSet, CheckResult } from "../../check/types.js";
import { backend, filesRef, templateFiles, type Files } from "../lib/backend.js";
import { headSha, resetHard } from "../lib/git.js";
import { recordScore } from "../lib/score.js";
import { liveLoop } from "../lib/live.js";
import { excerpt, type AttemptOutcome } from "./channel.js";

// Inngest caps a run at 1000 steps (platform limit; the SDK itself doesn't
// enforce it). Each iteration uses at most ~6 steps (invoke, check, sendEvent,
// score, revert-or-rebaseline, live publish; an unchanged attempt skips check
// and revert) plus an occasional review wait and its two live publishes, so
// budget 9 per iteration and reserve ~10 for baseline/holdout/finished.
const STEP_LIMIT = 1000;
const STEPS_PER_ITERATION = 9;
const RESERVED_STEPS = 10;
const MAX_ATTEMPTS_CAP = Math.floor((STEP_LIMIT - RESERVED_STEPS) / STEPS_PER_ITERATION); // 141

// In the sandbox backend there's no git: a "commit" is a content hash of the
// files, and the best result carries the files themselves (step state is the
// only storage).
type Best = CheckResult & { files?: Files };

type AttemptResult = {
  commit: string;
  changed: boolean;
  files?: Files;
  summary: string;
  turns: number;
  idleTurns: number;
  tokens: { input: number; output: number };
  finished: boolean;
  costUsd: number;
};

const isAttemptResult = (x: unknown): x is AttemptResult => {
  const a = x as Partial<AttemptResult> | null | undefined;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.commit === "string" &&
    typeof a.changed === "boolean" &&
    typeof a.costUsd === "number" &&
    typeof a.tokens?.input === "number" &&
    typeof a.tokens?.output === "number"
  );
};

const check = (at:{ commit: string; files?: Files }, set: CaseSet): Promise<CheckResult> =>
  backend() === "sandbox"
    ? runCheckSandbox({ files: at.files ?? {}, ref: at.commit, set })
    : runCheck({ commit: at.commit, set });

export const goalLoop = inngest.createFunction(
  {
    id: "goal-loop",
    concurrency: [{ key: "event.data.goalId", limit: 1 }],
    triggers: [goalStarted],
  },
  async ({ event, step }) => {
    const { goalId } = event.data;
    // Env is read inside a step so a redeploy with a different MODEL can't
    // change the model of a run that's already in flight.
    const model =
      event.data.model ??
      (await step.run("resolve-model", () => process.env.MODEL || DEFAULT_MODEL));
    const maxAttempts = Math.min(event.data.maxAttempts ?? GOAL_DEFAULTS.maxAttempts, MAX_ATTEMPTS_CAP);
    const maxStalls = event.data.maxStalls ?? GOAL_DEFAULTS.maxStalls;
    const maxTurns = event.data.maxTurnsPerAttempt ?? GOAL_DEFAULTS.maxTurnsPerAttempt;
    // Reasoning controls are opt-in: sending `reasoning` to a non-thinking model
    // makes OpenRouter (with require_parameters) find no provider at all.
    const reasoningEffort = event.data.reasoningEffort;
    const maxTokensPerTurn = event.data.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn;
    const reasoningMaxTokens = event.data.reasoningMaxTokens;

    const sandbox = backend() === "sandbox";

    const baseline: Best = await step.run("baseline", async () => {
      if (sandbox) {
        // The stub source from the template; there is no workspace repo.
        const files = templateFiles();
        return { ...(await check({ commit: filesRef(files), files }, "train")), files };
      }
      return check({ commit: await headSha() }, "train");
    });

    await liveLoop(step, "live-started", goalId, {
      type: "goal.started",
      model,
      maxAttempts,
      maxStalls,
      baseline: { failed: baseline.failed, total: baseline.total, score: baseline.score },
    });

    let best: Best = baseline;
    let stalls = 0;
    let humanNote: string | undefined;
    let attempts = 0;
    let totalCostUsd = 0;
    const totalTokens = { input: 0, output: 0 };

    for (let i = 1; i <= maxAttempts; i++) {
      attempts = i;

      // An attempt that exhausts its retries (provider outage, bad model output)
      // counts as a no-change stall rather than failing the whole goal. The
      // failure is memoized like any step result, so replay stays deterministic.
      // A cancelled attempt doesn't reject the invoke: it resolves without an
      // attempt result, so anything that isn't one is treated the same way.
      const failedAttempt = (summary: string) => ({
        commit: best.commit,
        changed: false,
        files: best.files,
        summary,
        turns: 0,
        idleTurns: 0,
        tokens: { input: 0, output: 0 },
        finished: false,
        costUsd: 0,
      });
      const invoked: unknown = await step
        .invoke(`attempt-${i}`, {
          function: agentAttempt,
          data: {
            goalId,
            i,
            bestCommit: best.commit,
            bestFiles: best.files,
            report: best.report,
            humanNote,
            best: { failed: best.failed, total: best.total },
            model,
            maxTurns,
            reasoningEffort,
            maxTokensPerTurn,
            reasoningMaxTokens,
          },
        })
        .catch(() => failedAttempt("attempt failed"));
      const attempt = isAttemptResult(invoked) ? invoked : failedAttempt("attempt cancelled or returned no result");

      totalCostUsd += attempt.costUsd;
      totalTokens.input += attempt.tokens.input;
      totalTokens.output += attempt.tokens.output;

      // An attempt that changed nothing (or failed) is still at `best`: skip the
      // check and the revert and count a stall. `changed` is memoized from the
      // invoke, so the step ids stay deterministic. A check change made in the
      // meantime is picked up by the next attempt that does change something.
      const result: CheckResult = attempt.changed
        ? await step.run(`check-${i}`, () => check({ commit: attempt.commit, files: attempt.files }, "train"))
        : best;

      await step.sendEvent(
        `scored-${i}`,
        goalAttemptScored.create({
          goalId,
          i,
          score: result.score,
          failed: result.failed,
          total: result.total,
          checkVersion: result.checkVersion,
          commit: result.commit,
          model,
          tokens: attempt.tokens,
          changed: attempt.changed,
          finished: attempt.finished,
          turns: attempt.turns,
          idleTurns: attempt.idleTurns,
          costUsd: attempt.costUsd,
          summary: excerpt(attempt.summary, 200),
          report: result.report,
        }),
      );
      await recordScore(step, `score-${i}`, "check.fail_rate", result.score);

      // The check changed under us (e.g. cases edited mid-run): re-score the
      // incumbent with the new check so scores stay comparable.
      if (attempt.changed && result.checkVersion !== best.checkVersion) {
        const rebaselined = await step.run(`rebaseline-${i}`, () => check(best, "train"));
        best = { ...rebaselined, files: best.files };
      }

      const outcome: AttemptOutcome = !attempt.changed
        ? attempt.turns === 0 && attempt.costUsd === 0
          ? "failed"
          : "unchanged"
        : result.score < best.score
          ? "kept"
          : "reverted";
      if (outcome === "kept") {
        best = { ...result, files: attempt.files };
        stalls = 0;
      } else {
        stalls++;
        // Sandbox backend: every attempt is seeded from `best.files`, so state
        // is already the best by construction and there is nothing to revert.
        if (!sandbox && attempt.changed) {
          await step.run(`revert-${i}`, async () => {
            await resetHard(best.commit);
            return { reverted: best.commit };
          });
        }
      }

      await liveLoop(step, `live-scored-${i}`, goalId, {
        type: "attempt.scored",
        i,
        score: result.score,
        failed: result.failed,
        total: result.total,
        changed: attempt.changed,
        turns: attempt.turns,
        idleTurns: attempt.idleTurns,
        costUsd: attempt.costUsd,
        outcome,
        bestScore: best.score,
        stalls,
        summary: excerpt(attempt.summary, 200),
      });

      if (result.pass) break;

      if (stalls >= maxStalls) {
        await liveLoop(step, `live-review-${i}`, goalId, { type: "review.waiting", i, stalls, bestScore: best.score, report: best.report });
        const review = await step.waitForEvent(`review-${i}`, {
          event: goalReviewSubmitted,
          match: "data.goalId",
          timeout: "3d",
        });
        await liveLoop(step, `live-resumed-${i}`, goalId, {
          type: "review.resumed",
          i,
          action: review?.data.action ?? "timeout",
          note: review?.data.note,
        });
        if (!review || review.data.action === "stop") break;
        humanNote = review.data.note;
        stalls = 0;
      }
    }

    // Scored once, on the final best commit; never shown to an agent.
    const holdout = await step.run("holdout", () => check(best, "holdout"));
    await recordScore(step, "score-holdout", "holdout.fail_rate", holdout.score);

    const bestSummary = { commit: best.commit, failed: best.failed, total: best.total, score: best.score };
    const holdoutSummary = {
      commit: holdout.commit,
      failed: holdout.failed,
      total: holdout.total,
      score: holdout.score,
      pass: holdout.pass,
    };
    await step.sendEvent(
      "finished",
      goalFinished.create({
        goalId,
        best: bestSummary,
        holdout: holdoutSummary,
        attempts,
        costUsd: totalCostUsd,
        tokens: totalTokens,
      }),
    );

    await liveLoop(step, "live-finished", goalId, {
      type: "goal.finished",
      attempts,
      costUsd: totalCostUsd,
      best: bestSummary,
      holdout: holdoutSummary,
    });

    return { best: bestSummary, holdout: holdoutSummary, attempts, costUsd: totalCostUsd, tokens: totalTokens };
  },
);
