import OpenAI from "openai";

// OpenRouter exposes an OpenAI-compatible /chat/completions endpoint, so the
// official `openai` SDK works unchanged — just point baseURL at OpenRouter.
// Constructed lazily so the app can boot for inspection without a key set;
// the call site below throws a clearer error if it's missing.
let _client: OpenAI | undefined;
function client(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    });
  }
  return _client;
}

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

export async function chat(prompt: string, model = DEFAULT_MODEL): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const completion = await client().chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter ${model} returned no content`);
  }
  return content;
}
