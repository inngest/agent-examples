import OpenAI from "openai";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import { CATEGORIES, URGENCIES, SENTIMENTS, parseTriage, TRIAGE_SYSTEM_PROMPT } from "./triage";

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

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

export const CANDIDATE_MODEL =
  process.env.OPENROUTER_MODEL_CANDIDATE ?? "anthropic/claude-3.5-haiku";

// Model used for LLM-as-judge scoring (see judge() below) — deliberately
// separate from DEFAULT_MODEL/CANDIDATE_MODEL so swapping the models under
// test doesn't also change what's grading them.
export const JUDGE_MODEL = process.env.OPENROUTER_JUDGE_MODEL ?? "openai/gpt-4o-mini";

// Tracer for the manual gen_ai.* spans below. @inngest/otel's preload registers
// the provider/exporter (works under Bun), but its automatic openai-SDK
// patching relies on Node module hooks that Bun doesn't fire — so we emit the
// GenAI semantic-convention span ourselves and Inngest extracts AI metadata
// from it exactly as if the SDK had been auto-instrumented.
const tracer = trace.getTracer("openrouter");

export async function chat(messages: ChatMessage[], model = DEFAULT_MODEL): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  return tracer.startActiveSpan(`chat ${model}`, async (span) => {
    // Prepended to a local copy, not the caller's `messages` array — the
    // transcript the caller passed in (and gets back for history/capture)
    // stays exactly what the user typed; only what's actually sent to the
    // model (and therefore what shows up in the gen_ai.prompt.* attributes
    // below) gets the triage system turn.
    const fullMessages: ChatMessage[] = [{ role: "system", content: TRIAGE_SYSTEM_PROMPT }, ...messages];
    const promptAttributes: Record<string, string> = {};
    fullMessages.forEach((message, i) => {
      promptAttributes[`gen_ai.prompt.${i}.role`] = message.role;
      promptAttributes[`gen_ai.prompt.${i}.content`] = message.content;
    });
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "openai",
      "gen_ai.request.model": model,
      "gen_ai.request.max_tokens": 1024,
      ...promptAttributes,
    });
    try {
      const completion = await client().chat.completions.create({
        model,
        max_tokens: 1024,
        messages: fullMessages,
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

export type JudgeVerdict = {
  categoryCorrect: boolean;
  urgencyCorrect: boolean;
  sentimentCorrect: boolean;
  replyQuality: number;
  contextAwareness: number;
};

const judgeVerdictSchema = z.object({
  category_correct: z.boolean(),
  urgency_correct: z.boolean(),
  sentiment_correct: z.boolean(),
  reply_quality: z.number(),
  context_awareness: z.number(),
});

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator of a support-ticket triage assistant's reply within a conversation.
Given the conversation so far (the customer's ticket, possibly across several turns) and the assistant's final reply — a JSON object with category/urgency/sentiment/suggested_reply — score the triage.
The assistant must pick from a fixed taxonomy; "correct" means the best available choice within it:
- category: one of ${CATEGORIES.join(", ")}
- urgency: one of ${URGENCIES.join(", ")}
- sentiment: one of ${SENTIMENTS.join(", ")}
Judge whether "category" is the best available category for the ticket described in the conversation.
Judge whether "urgency" is the right level given the ticket's real severity/impact as described.
Judge whether "sentiment" is a fair read of the customer's tone.
Judge reply_quality (0..1): is suggested_reply short, empathetic, and appropriate for a customer to actually read.
Judge context_awareness (0..1): for multiturn tickets, did the triage correctly account for information revealed in earlier turns (e.g. an escalation or category change)? Score 1 if this is a single-turn ticket (nothing earlier to account for).
Respond with ONLY a JSON object (no markdown, no commentary) in exactly this shape:
{"category_correct": <bool>, "urgency_correct": <bool>, "sentiment_correct": <bool>, "reply_quality": <0..1>, "context_awareness": <0..1>}`;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// Strip a wrapping ```json ... ``` or ``` ... ``` fence, if the judge model
// added one despite the "no markdown" instruction.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

// One judge LLM call that grades the assistant's final reply against the
// conversation it was given. Fanned out into five named scores by
// judgeScorer (see src/inngest/scorers.ts) — this function only produces the
// verdict, it doesn't write any scores itself.
export async function judge(messages: ChatMessage[], reply: string): Promise<JudgeVerdict> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  // If the reply isn't even valid triage JSON, there's nothing to judge for
  // category/urgency/sentiment correctness — short-circuit deterministically
  // in code instead of spending a judge LLM call (and trusting it to notice)
  // on input that's already known to be garbage.
  if (!parseTriage(reply)) {
    return {
      categoryCorrect: false,
      urgencyCorrect: false,
      sentimentCorrect: false,
      replyQuality: 0,
      contextAwareness: 0,
    };
  }

  return tracer.startActiveSpan(`chat ${JUDGE_MODEL}`, async (span) => {
    const judgeMessages: ChatMessage[] = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      ...messages,
      { role: "assistant", content: reply },
    ];
    const promptAttributes: Record<string, string> = {};
    judgeMessages.forEach((message, i) => {
      promptAttributes[`gen_ai.prompt.${i}.role`] = message.role;
      promptAttributes[`gen_ai.prompt.${i}.content`] = message.content;
    });
    span.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "openai",
      "gen_ai.request.model": JUDGE_MODEL,
      "gen_ai.request.max_tokens": 512,
      ...promptAttributes,
    });
    try {
      const completion = await client().chat.completions.create({
        model: JUDGE_MODEL,
        max_tokens: 512,
        messages: judgeMessages,
      });

      const choice = completion.choices[0];
      const content = choice?.message?.content;
      span.setAttributes({
        "gen_ai.response.model": completion.model,
        "gen_ai.response.id": completion.id,
        "gen_ai.usage.input_tokens": completion.usage?.prompt_tokens ?? 0,
        "gen_ai.usage.output_tokens": completion.usage?.completion_tokens ?? 0,
        "gen_ai.completion.0.role": "assistant",
        "gen_ai.completion.0.content": content ?? "",
        "gen_ai.completion.0.finish_reason": choice?.finish_reason ?? "",
      });

      if (!content) {
        throw new Error(`OpenRouter ${JUDGE_MODEL} judge call returned no content`);
      }

      // Parsed tolerantly (fence-stripped, zod-validated, clamped) rather than
      // trusted outright — the judge model is instructed to emit bare JSON but
      // may still wrap it in a fence or drift on numeric ranges. Anything that
      // doesn't parse/validate throws, so Inngest retries the step.
      const parsed = JSON.parse(stripCodeFence(content));
      const verdict = judgeVerdictSchema.parse(parsed);

      return {
        categoryCorrect: verdict.category_correct,
        urgencyCorrect: verdict.urgency_correct,
        sentimentCorrect: verdict.sentiment_correct,
        replyQuality: clamp01(verdict.reply_quality),
        contextAwareness: clamp01(verdict.context_awareness),
      };
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
