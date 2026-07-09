import { inngest } from "./client";
import { runAgent } from "../agent.stage2";

export const runAgentFn = inngest.createFunction(
  { id: "run-agent", triggers: [{ event: "agent/run.requested" }] },
  async ({ event, step }) => {
    return runAgent(step, event.data.prompt);
  },
);
