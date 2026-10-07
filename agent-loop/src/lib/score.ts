// All scoring goes through here so SDK API changes touch one place.
// step.score() (scoreMiddleware, inngest/experimental) returns void, so its
// step shows a null output in the dashboard. Instead, write the score with
// inngest.score() inside our own step.run: called from inside a step it
// attaches the same inngest.score metadata to that step, and the step output
// carries the value too.
import { inngest } from "../inngest/client.js";
import type { RunStep } from "./step-types.js";

export async function recordScore(step: RunStep, id: string, name: string, value: number | boolean): Promise<void> {
  await step.run(id, async () => {
    await inngest.score({ name, value });
    return { name, value };
  });
}
