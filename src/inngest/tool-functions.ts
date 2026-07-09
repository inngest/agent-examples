import { inngest } from "./client";
import { executeTool, toolDefinitions } from "../tools";

// One Inngest function per declared tool — no tool name hardcoded here.
export const toolFunctions = toolDefinitions.map((def) =>
  inngest.createFunction(
    { id: `tool-${def.name}`, retries: 5, triggers: [{ event: `tool/${def.name}.requested` }] },
    async ({ event }) => {
      const result = await executeTool(def.name, event.data.input);
      await inngest.send({
        name: `tool/${def.name}.completed`,
        data: { toolCallId: event.data.toolCallId, result },
      });
    },
  ),
);
