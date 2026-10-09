import { Inngest } from "inngest";
import { metadataMiddleware, sandboxMiddleware, scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "goal-loop",
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version for rolling deploys (set from RENDER_GIT_COMMIT in the Dockerfile).
  appVersion: process.env.INNGEST_APP_VERSION,
  middleware: [
    // Experimental score API (src/lib/score.ts): plots the fail-rate per attempt.
    scoreMiddleware(),
    // inngest.metadata, used by src/lib/model-call.ts to attach `model_call`
    // metadata (provider, latency, tokens) to each turn.
    metadataMiddleware(),
    // step.sandbox (check/run-check-sandbox.ts): the sandbox grader's create,
    // exec and destroy show up as sandbox steps in the trace.
    sandboxMiddleware(),
  ],
});
