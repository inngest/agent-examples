import { inngest } from "./client";
import { chat } from "../openrouter";

// The whole agent: one durable step around the model call. Because it's a
// step, a crash or timeout mid-call retries this step alone — the orchestrator
// never restarts from scratch. That's the entire point of Phase 1.
export const agentRun = inngest.createFunction(
  { id: "agent-run", triggers: { event: "agent/run.requested" } },
  async ({ event, step }) => {
    const { prompt, model } = event.data;

    const reply = await step.run("call-model", async () => {
      return await chat(prompt, model);
    });

    return { reply };
  },
);
