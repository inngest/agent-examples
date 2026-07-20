import { inngest } from "./client";
import { executeTool, toolDefinitions } from "../tools";

// One Inngest function per declared tool, keyed by tool name so the agent loop
// can resolve it by name for step.invoke — no tool name hardcoded here.
export const toolFunctions = Object.fromEntries(
  toolDefinitions.map((def) => [
    def.name,
    inngest.createFunction(
      { id: `tool-${def.name}`, retries: 5, triggers: [{ event: `tool/${def.name}.requested` }] },
      async ({ event, step }) =>
        // Return the step result directly — step.invoke hands it back to the
        // caller. The toolCallId rides along as the tool's idempotency key.
        step.run(`tool/${def.name}`, () =>
          executeTool(def.name, event.data.input, event.data.toolCallId),
        ),
    ),
  ]),
);
