import OpenAI from "openai";

// Single OpenRouter client shared by the chat agent (agent.ts) and the
// LLM-judge scorers (scorers.ts). OpenRouter speaks the OpenAI-compatible
// Chat Completions API, so we use the `openai` SDK pointed at OpenRouter's
// base URL rather than a provider-specific client — one API key, one endpoint,
// whatever pair of models the experiment buckets into (MODEL_A / MODEL_B in
// chat-function.ts).
export const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  // Optional attribution headers OpenRouter uses for its app rankings; harmless
  // when unset.
  defaultHeaders: {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://github.com/inngest/agent-examples",
    "X-Title": "token-streaming-agent",
  },
});
