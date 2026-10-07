import fs from "node:fs";
import path from "node:path";
import { NonRetriableError } from "inngest";
import { DATA_DIR } from "../lib/paths.js";
import { inngest } from "./client.js";
import { agentAttempt, isAttemptResult } from "./agent-attempt.js";
import { DEFAULT_MODEL, GOAL_DEFAULTS, goalAttemptScored, goalFinished, goalReviewSubmitted, goalStarted } from "./events.js";
import { runCheck } from "../../check/run-check.js";
import { runCheckSandbox } from "../../check/run-check-sandbox.js";
import type { CaseSet, CheckResult } from "../../check/types.js";
import { backend, type Files } from "../lib/backend.js";
import { recordScore } from "../lib/score.js";
import { pickFocus, unimplemented } from "../lib/prompt.js";
import { liveLoop } from "../lib/live.js";
import { modelBaseUrl, modelProfile } from "../lib/openrouter.js";
import { MAX_TOKENS_CAP } from "../lib/reasoning-ladder.js";
import { afterAttempt, failedAttempt, initialState, type Best } from "../lib/loop-state.js";
import { workspace } from "../lib/workspace.js";
import { excerpt } from "./channel.js";

// Inngest caps a run at 1000 steps (platform limit; the SDK itself doesn't
// enforce it). An iteration takes 4 steps when the attempt changed nothing
// (invoke, scored event, score, live publish), 5-6 when it did (+ check,
// + revert unless kept), and 3 more when it ends in a review wait (live,
// wait, live): at most 9, which is the budget. A rebaseline adds one only in
// an iteration where the check itself changed mid-run; the reserve (7 steps:
// settings, baseline, live-started, holdout, score-holdout, finished,
// live-finished) leaves room for a few.
const STEP_LIMIT = 1000;
const STEPS_PER_ITERATION = 9;
const RESERVED_STEPS = 10;
const MAX_ATTEMPTS_CAP = Math.floor((STEP_LIMIT - RESERVED_STEPS) / STEPS_PER_ITERATION); // 110

// `against`: the best result's failBits, so the check reports the cases this
// attempt broke (train only).
const check = (at: { commit: string; files?: Files }, set: CaseSet, against?: string): Promise<CheckResult> =>
  backend() === "sandbox"
    ? runCheckSandbox({ files: at.files ?? {}, ref: at.commit, set, against })
    : runCheck({ commit: at.commit, set, against });

export const goalLoop = inngest.createFunction(
  {
    id: "goal-loop",
    concurrency: [{ key: "event.data.goalId", limit: 1 }],
    triggers: [goalStarted],
  },
  async ({ event, step }) => {
    const { goalId } = event.data;
    const maxAttempts = Math.min(event.data.maxAttempts ?? GOAL_DEFAULTS.maxAttempts, MAX_ATTEMPTS_CAP);
    const maxStalls = event.data.maxStalls ?? GOAL_DEFAULTS.maxStalls;
    const focusOn = event.data.focus ?? true; // one function per attempt (see pickFocus)

    // Env is read inside a step, once, so a redeploy with a different MODEL or
    // REASONING_* can't change a run that's already in flight.
    const settings = await step.run("settings", async () => {
      const model = event.data.model ?? (process.env.MODEL || DEFAULT_MODEL);
      // What the model can do on OpenRouter, so any listed model works without per-model flags.
      const profile = await modelProfile(model, modelBaseUrl());
      // Reasoning controls are opt-in, and sent only where the profile says a
      // provider takes them (otherwise require_parameters finds no provider).
      // The event wins over REASONING_EFFORT / REASONING_MAX_TOKENS. Reasoning
      // tokens count against maxTokensPerTurn, so raise that too.
      const rawEffort = process.env.REASONING_EFFORT?.trim().toLowerCase();
      const envMaxTokens = Number(process.env.REASONING_MAX_TOKENS);
      const envEffort = (["low", "medium", "high"] as const).find((e) => e === rawEffort);
      const envReasoningMaxTokens = Number.isInteger(envMaxTokens) && envMaxTokens > 0 ? envMaxTokens : undefined;
      // Never ask for more than any provider will generate; the ladder grows
      // the budget up to the same limit.
      const maxTokensCap = Math.min(profile.maxCompletionTokens ?? MAX_TOKENS_CAP, MAX_TOKENS_CAP);
      return {
        model,
        profile,
        // Opt-in: Go's documentation for the brief, read here so a replay
        // sees the same text even if a redeploy changed the file.
        spec: event.data.spec ? fs.readFileSync(path.join(DATA_DIR, "spec.txt"), "utf8") : undefined,
        attempt: {
          slug: model,
          maxTurns: event.data.maxTurnsPerAttempt ?? GOAL_DEFAULTS.maxTurnsPerAttempt,
          maxTokensPerTurn: Math.min(event.data.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn, maxTokensCap),
          maxTokensCap,
          supportsReasoning: profile.supportsReasoning,
          reasoningEffort: profile.supportsReasoning ? (event.data.reasoningEffort ?? envEffort) : undefined,
          reasoningMaxTokens: profile.supportsReasoning ? (event.data.reasoningMaxTokens ?? envReasoningMaxTokens) : undefined,
        },
      };
    });
    const { model, profile } = settings;
    if (!profile.supportsTools) {
      await liveLoop(step, "live-unsupported", goalId, {
        type: "goal.failed",
        reason: profile.missing
          ? `${model} isn't a model on OpenRouter (check the slug)`
          : `${model}: no OpenRouter provider serves it with tools and tool_choice, which the loop needs`,
      });
      throw new NonRetriableError(profile.missing ? `${model} is not on OpenRouter` : `${model} has no OpenRouter endpoint that supports tools with tool_choice`);
    }

    const ws = workspace();
    const baseline: Best = await step.run("baseline", async () => {
      const at = await ws.initial();
      const result = await check(at, "train");
      return at.files ? { ...result, files: at.files } : result;
    });

    await liveLoop(step, "live-started", goalId, {
      type: "goal.started",
      model,
      maxAttempts,
      maxStalls,
      baseline: { failed: baseline.failed, total: baseline.total, score: baseline.score },
    });

    // Replay: the state is rebuilt on every run of this function from memoized
    // step results only (see loop-state.ts), so each replay takes the same path.
    let state = initialState(baseline);
    let attempts = 0;

    for (let i = 1; i <= maxAttempts; i++) {
      attempts = i;
      const { best } = state;

      // Pick what this attempt works on.
      const stubs = unimplemented(best.byFn);
      const focus = focusOn ? pickFocus(best.byFn, state.focusMisses) : undefined;

      // Run the attempt. One that exhausts its retries (provider outage, bad
      // model output) counts as a no-change stall rather than failing the goal;
      // the failure is memoized like any step result.
      const invoked: unknown = await step
        .invoke(`attempt-${i}`, {
          function: agentAttempt,
          data: {
            goalId,
            i,
            start: { commit: best.commit, files: best.files },
            brief: {
              best: { failed: best.failed, total: best.total },
              humanNote: state.humanNote,
              report: best.report,
              examples: best.examples,
              journal: state.journal,
              regressions: state.regressions,
              focus,
              stubs,
              ...(settings.spec ? { spec: settings.spec } : {}),
              // Only the focus function's list travels with the attempt.
              ...(event.data.examplesPerBrief
                ? { examplesPerBrief: event.data.examplesPerBrief, focusExamples: focus ? best.examplesByFn?.[focus.fn] : undefined }
                : {}),
            },
            model: { ...settings.attempt, learned: state.learned },
          },
        })
        .catch(() => failedAttempt(best, "attempt failed"));
      const attempt = isAttemptResult(invoked) ? invoked : failedAttempt(best, "attempt cancelled or returned no result");

      // Check it. An attempt that changed nothing (or failed) is still at
      // `best`: skip the check. `changed` is memoized from the invoke, so the
      // step ids stay deterministic.
      const result: CheckResult = attempt.changed
        ? await step.run(`check-${i}`, () => check({ commit: attempt.commit, files: attempt.files }, "train", best.failBits))
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
      // incumbent with the new check so scores stay comparable. A change made
      // during an unchanged attempt is picked up by the next changed one.
      const rebaselined =
        attempt.changed && result.checkVersion !== best.checkVersion
          ? await step.run(`rebaseline-${i}`, () => check(best, "train"))
          : undefined;

      // Keep or revert, and carry the context forward.
      const after = afterAttempt(state, { i, attempt, result, focus, rebaselined });
      state = after.state;
      const { outcome } = after;
      if (outcome !== "kept" && attempt.changed && ws.revert) {
        const revert = ws.revert;
        await step.run(`revert-${i}`, async () => {
          await revert(state.best.commit);
          return { reverted: state.best.commit };
        });
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
        bestScore: state.best.score,
        stalls: state.stalls,
        summary: excerpt(attempt.summary, 200),
      });

      if (result.pass) break;

      // Park for a human after maxStalls attempts without progress.
      if (state.stalls >= maxStalls) {
        await liveLoop(step, `live-review-${i}`, goalId, {
          type: "review.waiting",
          i,
          stalls: state.stalls,
          bestScore: state.best.score,
          report: state.best.report,
        });
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
        state = { ...state, humanNote: review.data.note, stalls: 0 };
      }
    }

    // Scored once, on the final best commit; never shown to an agent.
    const { best, costUsd, tokens } = state;
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
        costUsd,
        tokens,
      }),
    );

    await liveLoop(step, "live-finished", goalId, {
      type: "goal.finished",
      attempts,
      costUsd,
      best: bestSummary,
      holdout: holdoutSummary,
    });

    return { best: bestSummary, holdout: holdoutSummary, attempts, costUsd, tokens };
  },
);
