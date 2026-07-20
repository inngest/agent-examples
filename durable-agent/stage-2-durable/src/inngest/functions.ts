import { inngest } from "./client";
import { runAgent } from "../agent";

export const runAgentFn = inngest.createFunction(
  { id: "run-agent", triggers: [{ event: "agent/run.requested" }] },
  async ({ event, step }) => runAgent(step, event.data.prompt),
);
