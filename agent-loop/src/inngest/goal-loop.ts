import { inngest } from "./client.js";
import { agentAttempt } from "./agent-attempt.js";
import { DEFAULT_MODEL, GOAL_DEFAULTS, goalAttemptScored, goalFinished, goalReviewSubmitted, goalStarted } from "./events.js";
import { runCheck } from "../../check/run-check.js";
import { runCheckSandbox } from "../../check/run-check-sandbox.js";
import type { CaseSet, CheckResult } from "../../check/types.js";
import { backend, sourceRef, templateSource } from "../lib/backend.js";
import { headSha, resetHard } from "../lib/git.js";
import { recordScore } from "../lib/score.js";

// Inngest caps a run at 1000 steps (platform limit; the SDK itself doesn't
// enforce it). Each iteration uses ~5 steps (invoke, check, sendEvent, score,
// revert-or-rebaseline) plus an occasional review wait, so budget 7 per
// iteration and reserve ~10 for baseline/holdout/finished.
const STEP_LIMIT = 1000;
const STEPS_PER_ITERATION = 7;
const RESERVED_STEPS = 10;
const MAX_ATTEMPTS_CAP = Math.floor((STEP_LIMIT - RESERVED_STEPS) / STEPS_PER_ITERATION); // 141

// In the sandbox backend there's no git: a "commit" is a content hash of the
// source, and the best result carries the source itself (step state is the
// only storage).
type Best = CheckResult & { source?: string };

const check = (at: { commit: string; source?: string }, set: CaseSet): Promise<CheckResult> =>
  backend() === "sandbox"
    ? runCheckSandbox({ source: at.source ?? "", ref: at.commit, set })
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
        const source = templateSource();
        return { ...(await check({ commit: sourceRef(source), source }, "train")), source };
      }
      return check({ commit: await headSha() }, "train");
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
      const attempt = await step
        .invoke(`attempt-${i}`, {
          function: agentAttempt,
          data: {
            goalId,
            i,
            bestCommit: best.commit,
            bestSource: best.source,
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
        .catch(() => ({
          commit: best.commit,
          changed: false,
          source: best.source,
          summary: "attempt failed",
          turns: 0,
          idleTurns: 0,
          tokens: { input: 0, output: 0 },
          finished: false,
          costUsd: 0,
        }));

      totalCostUsd += attempt.costUsd;
      totalTokens.input += attempt.tokens.input;
      totalTokens.output += attempt.tokens.output;

      const result = await step.run(`check-${i}`, () => check({ commit: attempt.commit, source: attempt.source }, "train"));

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
        }),
      );
      await recordScore(step, `score-${i}`, "check.fail_rate", result.score);

      // The check changed under us (e.g. cases edited mid-run): re-score the
      // incumbent with the new check so scores stay comparable.
      if (result.checkVersion !== best.checkVersion) {
        const rebaselined = await step.run(`rebaseline-${i}`, () => check(best, "train"));
        best = { ...rebaselined, source: best.source };
      }

      if (result.score < best.score) {
        best = { ...result, source: attempt.source };
        stalls = 0;
      } else {
        stalls++;
        // Sandbox backend: every attempt is seeded from `best.source`, so state
        // is already the best by construction and there is nothing to revert.
        if (!sandbox) {
          await step.run(`revert-${i}`, async () => {
            await resetHard(best.commit);
            return { reverted: best.commit };
          });
        }
      }

      if (result.pass) break;

      if (stalls >= maxStalls) {
        const review = await step.waitForEvent(`review-${i}`, {
          event: goalReviewSubmitted,
          match: "data.goalId",
          timeout: "3d",
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

    return { best: bestSummary, holdout: holdoutSummary, attempts, costUsd: totalCostUsd, tokens: totalTokens };
  },
);
