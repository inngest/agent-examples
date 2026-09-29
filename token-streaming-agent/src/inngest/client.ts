import { Inngest } from "inngest";
import { sandboxMiddleware, scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "token-streaming-agent",
  // Required to publish events to Inngest Cloud. Omit for local dev
  // (the Dev Server intercepts events without a key).
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version of the app so Inngest can support
  // rolling deploys. Use a git sha, build number, image tag, etc.
  appVersion: process.env.INNGEST_APP_VERSION,
  // Enables step.score() and inngest.score.experiment(...) so the
  // haiku-vs-opus experiment in chat-function.ts can attach scores to runs.
  // sandboxMiddleware enables step.sandbox, which run_python uses to run
  // model-written code in an isolated Inngest Sandbox (worker/sandbox).
  middleware: [scoreMiddleware(), sandboxMiddleware()],
});
