// The /goal loop: grade the stubs, then attempt after attempt until the check
// passes, a reviewer stops it, or the attempts run out. Each attempt is a coder
// run on the goal's thread; the grader scores it on a machine the model can't
// reach; the best code is kept. After maxStalls attempts without progress the
// goal waits for a reviewer. The holdout is scored once, at the end.
//
// Everything that happens goes into the goal's log; the best code, the note,
// stalls and what the brief shows are read off it (src/lib/goal-log.ts).
import { NonRetriableError, experiment, step } from "inngest";
import { grade } from "../../check/grade.js";
import { STUB } from "../config.js";
import { agents } from "../inngest/client.js";
import { goalReviewSubmitted, goalStarted } from "../inngest/events.js";
import { templateFiles } from "../lib/files.js";
import { best, checkAttempt, stalls, stopped, totals, type GoalLog, type Review } from "../lib/goal-log.js";
import { attemptBrief, focusFor } from "../lib/prompt.js";
import { reporter } from "../lib/report.js";
import { goalSettings } from "../lib/settings.js";
import { grader } from "../sandboxes.js";
import { coder } from "./coder.js";

export const goal = agents.agent(
  {
    id: "goal",
    triggers: [goalStarted],
    thread: "event.data.goalId",
    // Reviews reach the goal at any time; the coder on this thread hears them too.
    inbox: [goalReviewSubmitted],
    sandboxes: { grader: grader.with({ model: false }) },
  },
  async ({ event, inbox, sandboxes, group, runId }) => {
    const { goalId, variant } = event.data;
    const settings = await step.run("settings", () => goalSettings(event.data));
    const { maxAttempts, maxStalls } = settings;
    const report = reporter({ goalId, runId, model: settings.model.slug, maxAttempts, maxStalls, variant });
    if (settings.unusable) {
      await report.failed(settings.unusable);
      throw new NonRetriableError(settings.unusable);
    }

    // A reviewer's message as a log entry. A note goes into every later brief; a stop ends the goal.
    const asReview = (message: Awaited<ReturnType<typeof inbox.next>>, i: number, resumed: boolean): Review[] => {
      if (!message?.is(goalReviewSubmitted)) return [];
      return [{ kind: "review", i, note: message.data.note, stop: message.data.action === "stop", resumed }];
    };

    // Reviews sent since the last look.
    const reviewsSince = async (i: number) => (await inbox.drain()).flatMap((message) => asReview(message, i, false));

    // After maxStalls attempts without progress: wait up to 3 days for a reviewer. No answer is a stop.
    const waitForReview = async (log: GoalLog, i: number): Promise<Review> => {
      await sandboxes.grader.recycle();
      await report.waiting(log, i);
      const [review = { kind: "review", i, stop: true, resumed: true, timedOut: true }] = asReview(await inbox.next({ timeout: "3d" }), i, true);
      await report.resumed(i, review);
      return review;
    };

    const runGoal = async () => {
      const log: GoalLog = [{ kind: "baseline", result: await grade(sandboxes.grader, "baseline", { commit: STUB, files: templateFiles() }, "train") }];
      await report.started(log);

      for (let i = 1; i <= maxAttempts && !best(log).pass && !stopped(log); i++) {
        log.push(...(await reviewsSince(i)));
        if (stopped(log)) break;

        const focus = focusFor(log, settings.brief.focus);
        // A coder run on the goal's thread. One that fails or is stopped is null: a stall, never the end of the goal.
        const attempt = await coder
          .start(
            {
              goalId,
              i,
              brief: attemptBrief(log, i, focus, settings.brief),
              files: best(log).files,
              maxTurns: settings.maxTurns,
              model: { ...settings.model, startRung: totals(log).startRung },
            },
            { thread: goalId },
          )
          .result()
          .catch(() => null);
        log.push(...(await checkAttempt(sandboxes.grader, log, i, attempt, focus)));
        await report.attempt(log);

        if (stalls(log) >= maxStalls && i < maxAttempts && !best(log).pass) {
          log.push(await waitForReview(log, i));
        }
      }

      // Scored once, on the final best; never shown to an attempt.
      return report.finished(log, await grade(sandboxes.grader, "holdout", best(log), "holdout"));
    };

    // In the "brief" experiment the goal runs inside its variant, so every
    // score counts toward it. The variant's brief options are in `settings`.
    if (!variant) return runGoal();
    const { result } = await group.experiment("brief", {
      variants: { control: runGoal, spec: runGoal, examples: runGoal, no_focus: runGoal },
      select: experiment.fixed(variant),
    });
    return result;
  },
);
