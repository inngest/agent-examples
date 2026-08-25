import { Inngest } from "inngest";
import { scoreMiddleware, sandboxMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "open-model-test",
  // Required to publish events to Inngest Cloud. Omit for local dev
  // (the Dev Server intercepts events without a key).
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version of the app so Inngest can support
  // rolling deploys. Use a git sha, build number, image tag, etc.
  appVersion: process.env.INNGEST_APP_VERSION,
  middleware: [
    // Enables step.score() so per-sample metrics (compiled, test-pass-rate,
    // latency, cost) are visible live in the Inngest dashboard.
    scoreMiddleware(),
    // Enables the durable step.sandbox tools for the (upcoming) sandbox
    // runner; the stubbed runner doesn't use them yet.
    sandboxMiddleware(),
  ],
});
