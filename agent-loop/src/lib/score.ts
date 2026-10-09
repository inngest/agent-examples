// All scoring goes through here so SDK API changes touch one place.
// step.score() (scoreMiddleware, inngest/experimental) returns void, so its
// step shows a null output in the dashboard. Instead, write the scores with
// inngest.score() inside our own step.run: called from inside a step it
// attaches the same inngest.score metadata to that step, and the step output
// carries the values too. All of a step's scores go in one step.run, so adding
// a score doesn't add a step.
// With `runId` the score is run-scoped (shown for the run, not just the step);
// with `experiment` it also counts toward that experiment's variant. Inside a
// step.run the SDK only makes it run-scoped when runId is passed explicitly.
import type { ExperimentRef } from "inngest/experimental";
import { inngest } from "../inngest/client.js";
import type { RunStep } from "./step-types.js";

export async function recordScores(
  step: RunStep,
  id: string,
  scores: Record<string, number | boolean>,
  opts: { experiment?: ExperimentRef; runId?: string } = {},
): Promise<void> {
  await step.run(id, async () => {
    for (const [name, value] of Object.entries(scores)) {
      if (opts.experiment) await inngest.score.experiment({ experiment: opts.experiment, runId: opts.runId, name, value });
      else await inngest.score({ runId: opts.runId, name, value });
    }
    return scores;
  });
}
