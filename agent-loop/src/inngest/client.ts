import { Inngest } from "inngest";
import { metadataMiddleware, scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "goal-loop",
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version for rolling deploys (set from RENDER_GIT_COMMIT in the Dockerfile).
  appVersion: process.env.INNGEST_APP_VERSION,
  // Enables the experimental score API (see src/lib/score.ts) so the fail-rate is plotted per attempt.
  // metadataMiddleware enables inngest.metadata, used by src/lib/model-call.ts
  // to attach `model_call` metadata (provider, latency, tokens) to each turn.
  middleware: [scoreMiddleware(), metadataMiddleware()],
});
