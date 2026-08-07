import { Inngest } from "inngest";
// scoreMiddleware() powers the score-write path — required for any scoring,
// including the value returned by a deferred createScorer() run.
import { scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "first-eval-example",
  middleware: [scoreMiddleware()],
});
