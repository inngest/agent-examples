import { Inngest } from "inngest";
import { scoreMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "docs-understanding-agent",
  eventKey: process.env.INNGEST_EVENT_KEY,
  appVersion: process.env.INNGEST_APP_VERSION,
  middleware: [scoreMiddleware()],
});
