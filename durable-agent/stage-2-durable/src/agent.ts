import Anthropic from "@anthropic-ai/sdk";
import type { GetStepTools } from "inngest";
import { toolDefinitions } from "./tools";
import type { inngest } from "./inngest/client";
import { toolFunctions } from "./inngest/tool-functions";

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

    // Invoke each requested tool as its own durable step. step.invoke resolves
    // the tool's Inngest function by name, runs it (with its own retries), and
    // returns the result directly — no completion event or toolCallId matching.
    // Promise.all fans out multiple tool calls in one turn; each invoke is its
    // own memoized step and results map back by return value, so they can't
    // cross-wire.
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map(async (block, i) => {
          const fn = toolFunctions[block.name];
          if (!fn) throw new Error(`Unknown tool: ${block.name}`);

          const content = await step.invoke(`run-${block.name}-${i}`, {
            function: fn,
            // toolCallId flows through as the idempotency key (see tools.ts).
            data: { input: block.input, toolCallId: block.id },
          });

          return { type: "tool_result", tool_use_id: block.id, content };
        }),
    );

    messages.push({ role: "user", content: toolResults });
  }
}
