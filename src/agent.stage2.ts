import Anthropic from "@anthropic-ai/sdk";
import type { GetStepTools } from "inngest";
import { toolDefinitions } from "./tools";
import type { inngest } from "./inngest/client";

// ANTHROPIC_BASE_URL lets this point at any Anthropic-compatible endpoint.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

type Step = GetStepTools<typeof inngest>;

export async function runAgent(step: Step, prompt: string): Promise<Anthropic.ContentBlock[]> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  while (true) {
    // Cast: step.run JSON-round-trips the result, but it's really a Message.
    const response = (await step.run("call-model", () =>
      client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        tools: toolDefinitions,
        messages,
      }),
    )) as Anthropic.Message;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content;
    }

    // Trigger the tool's own Inngest function, then wait for it to reply.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      await step.sendEvent(`trigger-${block.name}`, {
        name: `tool/${block.name}.requested`,
        data: { toolCallId: block.id, input: block.input },
      });

      const completion = await step.waitForEvent(`wait-${block.name}`, {
        event: `tool/${block.name}.completed`,
        timeout: "5m",
        if: `async.data.toolCallId == ${JSON.stringify(block.id)}`,
      });

      if (!completion) {
        throw new Error(`tool ${block.name} did not complete within 5m`);
      }

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: completion.data.result });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
