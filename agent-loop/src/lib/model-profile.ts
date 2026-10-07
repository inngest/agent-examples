// What a model can do on OpenRouter, read once per goal (in a step) from the
// public endpoints API, so the harness can try almost any model without
// per-model flags: refuse a model nothing serves with tools, send `reasoning`
// only where it's accepted, and keep the turn budget under what providers
// will actually generate.
//
// It can't tell *how* a model honours reasoning controls (a token budget that
// holds, an effort level that's a hint, or on/off only: mistral-large-4-0
// ignored both a 1,500-token budget and effort "low"). That part the attempt
// learns from what comes back (see the reasoning ladder in agent-attempt).
type Endpoint = {
  provider_name: string;
  context_length: number;
  max_completion_tokens: number | null;
  supported_parameters: string[];
};

export type ModelProfile = {
  // OpenRouter answered 404: no such model (usually a typo in the slug).
  missing?: boolean;
  // false only when OpenRouter lists the model and no endpoint takes tools
  // with tool_choice (the loop needs both).
  supportsTools: boolean;
  // Some endpoint that takes tools also takes `reasoning`. Sending it to one
  // that doesn't makes OpenRouter (require_parameters) find no provider.
  supportsReasoning: boolean;
  // The largest max_completion_tokens among tool endpoints; undefined when
  // unknown (not listed, or some endpoint has no stated limit).
  maxCompletionTokens?: number;
  providers: string[];
};

const permissive: ModelProfile = { supportsTools: true, supportsReasoning: true, providers: [] };

/**
 * The profile, or a permissive one when it can't be read (another endpoint than
 * OpenRouter, an API error, offline): then nothing is checked and the request
 * flags decide, as before. An unknown slug (404) or a model no provider serves
 * comes back with supportsTools false, so the goal fails at once.
 */
export async function modelProfile(model: string, baseUrl: string): Promise<ModelProfile & { known: boolean }> {
  if (!baseUrl.includes("openrouter.ai")) return { ...permissive, known: false };
  let eps: Endpoint[];
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
    if (r.status === 404) return { ...permissive, supportsTools: false, missing: true, known: true };
    if (!r.ok) return { ...permissive, known: false };
    eps = ((await r.json()) as { data?: { endpoints?: Endpoint[] } }).data?.endpoints ?? [];
  } catch {
    return { ...permissive, known: false };
  }
  // Listed, but no provider serves it any more (llama-3-8b-instruct today).
  if (!eps.length) return { ...permissive, supportsTools: false, supportsReasoning: false, known: true };
  const tools = eps.filter((e) => e.supported_parameters.includes("tools") && e.supported_parameters.includes("tool_choice"));
  const limits = tools.map((e) => e.max_completion_tokens);
  return {
    known: true,
    supportsTools: tools.length > 0,
    supportsReasoning: tools.some((e) => e.supported_parameters.includes("reasoning")),
    maxCompletionTokens: limits.length && limits.every((n): n is number => typeof n === "number" && n > 0) ? Math.max(...limits) : undefined,
    providers: tools.map((e) => e.provider_name),
  };
}
