// One model turn: the request body (buildRequest) and the call (callModel).
//
// MODEL_CALL=worker (the default) makes the call from the worker inside
// step.ai.wrap, so it still shows as an AI step in the trace (request as
// input, response as output). It goes through the OpenAI SDK (v6:
// @traceloop/instrumentation-openai only patches >=4 <7) so that, with the
// `@inngest/otel/node` preload, the call emits gen_ai.* spans and Inngest
// attaches `inngest.ai` metadata (model, tokens, latency, cost) automatically.
//
// Why not step.ai.infer: infer makes the call from the Inngest server, which
// is durable across worker restarts but opaque: a request that never comes
// back has no timeout we control and nothing to log (see BUILD_LOG). Here the
// call has a timeout, every failure is classified for retry, the worker logs
// each turn, and the step also gets `model_call` metadata for what gen_ai
// doesn't carry (provider, finish reason, reasoning tokens, generation id, the
// HTTP status of a failure). MODEL_CALL=inngest keeps infer.
import { NonRetriableError, type GetStepTools } from "inngest";
import OpenAI from "openai";
import { inngest } from "../inngest/client.js";
import { isOpenRouter, modelBaseUrl } from "./openrouter.js";
import type { Reasoning } from "./reasoning-ladder.js";

export type ChatResponse = {
  id?: string;
  model?: string;
  provider?: string;
  choices?: { message?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string; code?: number };
};

type Logger = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

export const modelCallMode = (): "worker" | "inngest" => (process.env.MODEL_CALL === "inngest" ? "inngest" : "worker");

const defaultTimeoutMs = () => {
  const n = Number(process.env.MODEL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
};

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

async function trace(values: Record<string, unknown>) {
  // Attaches to the current step attempt; never let it fail the call (the
  // getter throws synchronously if metadataMiddleware isn't installed).
  try {
    await inngest.metadata.update(values, "model_call");
  } catch {
    // tracing is best-effort
  }
}

/**
 * Returns the function to hand to step.ai.wrap. `url` and `apiKey` are closed
 * over (wrap records the function's arguments in the trace, so the key must
 * not be one); `label` identifies the turn in the logs.
 */
export function modelCaller(opts: { baseURL: string; apiKey?: string; label: string; logger: Logger; timeoutMs?: number }) {
  const timeoutMs = () => opts.timeoutMs ?? defaultTimeoutMs();
  // Retries belong to the step (memoized, visible in the trace), not the SDK.
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey ?? "", timeout: timeoutMs(), maxRetries: 0 });
  return async (body: Record<string, unknown>): Promise<ChatResponse> => {
    const { label, logger } = opts;
    const started = Date.now();
    const ms = () => Date.now() - started;
    const messages = Array.isArray(body.messages) ? body.messages.length : 0;
    logger.info(`[${label}] model call start: ${body.model} · ${messages} messages · max_tokens ${body.max_tokens} · timeout ${timeoutMs() / 1000}s`);

    let json: ChatResponse;
    try {
      // OpenRouter's extra body fields (provider, reasoning) pass through as is.
      json = (await client.chat.completions.create(body as never)) as unknown as ChatResponse;
    } catch (err) {
      const timedOut = err instanceof OpenAI.APIConnectionTimeoutError;
      const status = err instanceof OpenAI.APIError && err.status ? err.status : timedOut ? "timeout" : "network_error";
      const detail = clip(
        timedOut ? `timed out after ${timeoutMs() / 1000}s` : `${(err as Error).message} ${JSON.stringify((err as { error?: unknown }).error ?? "")}`,
      );
      logger.warn(`[${label}] model call error ${status} after ${ms()}ms: ${detail}`);
      await trace({ status, latencyMs: ms(), error: detail });
      // A malformed request won't get better on retry (it used to be the
      // gateway's NonRetriable 400); rate limits, timeouts and 5xx might.
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new NonRetriableError(`model call ${status}: ${detail}`);
      }
      throw new Error(`model call ${status}: ${detail}`); // retried by the step
    }

    // OpenRouter can answer 200 with an `error` body (an upstream failure).
    if (json.error || !json.choices?.length) {
      const detail = clip(json.error?.message ?? "response had no choices");
      logger.warn(`[${label}] model call error ${json.error?.code ?? "no_choices"} after ${ms()}ms: ${detail}`);
      await trace({ status: json.error?.code ?? "no_choices", latencyMs: ms(), provider: json.provider, error: detail });
      throw new Error(`model call failed upstream: ${detail}`);
    }

    const choice = json.choices[0];
    const info = {
      status: 200,
      latencyMs: ms(),
      provider: json.provider,
      model: json.model,
      finishReason: choice?.finish_reason,
      toolCalls: choice?.message?.tool_calls?.length ?? 0,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens,
      costUsd: json.usage?.cost,
      generationId: json.id,
    };
    logger.info(
      `[${label}] model call ok in ${info.latencyMs}ms · ${info.provider} · ${info.finishReason} · ${info.toolCalls} tool calls · ` +
        `in ${info.promptTokens} / out ${info.completionTokens} (reasoning ${info.reasoningTokens ?? "?"}) · ${info.generationId}`,
    );
    await trace(info);
    return json;
  };
}

/**
 * The request body for one turn. Every turn must act through a tool
 * (tool_choice "required"; finish_attempt is the only way out): small models
 * otherwise drift into writing code as chat text.
 */
export function buildRequest(opts: {
  model: string;
  messages: unknown[];
  tools: unknown[];
  baseUrl: string;
  maxTokens: number;
  reasoning?: Reasoning;
}): Record<string, unknown> {
  // OpenRouter otherwise may route to a provider that silently ignores
  // tool_choice, so only route to providers that honour every parameter.
  // MODEL_PROVIDERS (comma-separated) pins a preference order, since the same
  // model differs by provider; without it, take the fastest.
  const preferred = (process.env.MODEL_PROVIDERS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const providerRouting = preferred.length ? { order: preferred } : { sort: "throughput" };
  return {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: "required",
    ...(isOpenRouter(opts.baseUrl) ? { provider: { require_parameters: true, ...providerRouting } } : {}),
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    max_tokens: opts.maxTokens,
  };
}

/** Where model calls go, from the worker's env. */
export const modelEndpoint = () => ({
  baseUrl: modelBaseUrl(),
  apiKey: process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY,
});

/**
 * One model call as step `id`. Same step id either way, and both return the
 * OpenAI response shape, so switching MODEL_CALL doesn't break replay of a run
 * in flight.
 */
export async function callModel(
  step: GetStepTools<typeof inngest>,
  id: string,
  body: Record<string, unknown>,
  opts: { model: string; baseUrl: string; apiKey?: string; label: string; logger: Logger; timeoutMs: number },
): Promise<ChatResponse> {
  const { model, baseUrl, apiKey } = opts;
  if (modelCallMode() === "worker")
    return (await step.ai.wrap(id, modelCaller({ baseURL: baseUrl, apiKey, label: opts.label, logger: opts.logger, timeoutMs: opts.timeoutMs }), body)) as ChatResponse;
  return (await step.ai.infer(id, { model: step.ai.models.openai({ model, baseUrl, apiKey }), body: body as never })) as ChatResponse;
}
