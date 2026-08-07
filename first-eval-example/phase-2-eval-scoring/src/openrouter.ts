import OpenAI from "openai";
import { trace, SpanStatusCode } from "@opentelemetry/api";

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

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

export const CANDIDATE_MODEL =
  process.env.OPENROUTER_MODEL_CANDIDATE ?? "anthropic/claude-3.5-haiku";

// Tracer for the manual gen_ai.* spans below. @inngest/otel's preload registers
// the provider/exporter (works under Bun), but its automatic openai-SDK
// patching relies on Node module hooks that Bun doesn't fire — so we emit the
// GenAI semantic-convention span ourselves and Inngest extracts AI metadata
// from it exactly as if the SDK had been auto-instrumented.
const tracer = trace.getTracer("openrouter");

export async function chat(prompt: string, model = DEFAULT_MODEL): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  return tracer.startActiveSpan(`chat ${model}`, async (span) => {
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "openai",
      "gen_ai.request.model": model,
      "gen_ai.request.max_tokens": 1024,
      "gen_ai.prompt.0.role": "user",
      "gen_ai.prompt.0.content": prompt,
    });
    try {
      const completion = await client().chat.completions.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const choice = completion.choices[0];
      span.setAttributes({
        "gen_ai.response.model": completion.model,
        "gen_ai.response.id": completion.id,
        "gen_ai.usage.input_tokens": completion.usage?.prompt_tokens ?? 0,
        "gen_ai.usage.output_tokens": completion.usage?.completion_tokens ?? 0,
        "gen_ai.completion.0.role": "assistant",
        "gen_ai.completion.0.content": choice?.message?.content ?? "",
        "gen_ai.completion.0.finish_reason": choice?.finish_reason ?? "",
      });

      const content = choice?.message?.content;
      if (!content) {
        throw new Error(`OpenRouter ${model} returned no content`);
      }
      return content;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
