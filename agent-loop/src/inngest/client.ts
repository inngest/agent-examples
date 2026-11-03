import { Inngest } from "inngest";
import { sandboxMiddleware, scoreMiddleware } from "inngest/experimental";
import { createAgents } from "inngest/experimental/agents";

export const inngest = new Inngest({
  id: "goal-loop",
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Identifies the deployed version for rolling deploys (set from RENDER_GIT_COMMIT in the Dockerfile).
  appVersion: process.env.INNGEST_APP_VERSION,
  middleware: [scoreMiddleware(), sandboxMiddleware()],
});

// No KV store: everything the goal carries comes from step results, and each
// run's sandboxes last for that run.
export const agents = createAgents(inngest);
