import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolDefinitions } from "./tools";


// ANTHROPIC_BASE_URL lets this point at any Anthropic-compatible endpoint.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

export async function runAgent(prompt: string): Promise<Anthropic.ContentBlock[]> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content;
    }

    // No try/catch — an uncaught tool failure kills the whole run.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
