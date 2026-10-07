import { Inngest } from "inngest";
import { scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "goal-loop",
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version for rolling deploys (set from RENDER_GIT_COMMIT in the Dockerfile).
  appVersion: process.env.INNGEST_APP_VERSION,
  // Enables step.score() so the check's fail-rate is plotted per attempt.
  middleware: [scoreMiddleware()],
});
