// What OpenRouter's public endpoints API (no key needed) says about a model:
// its profile, read once per goal, and per-provider context windows for the
// `pnpm goal:watch` context meter.
type Endpoint = {
  provider_name: string;
  context_length: number;
  max_completion_tokens: number | null;
  supported_parameters: string[];
};

/** The model endpoint the worker calls; read at call time so .env order doesn't matter. */
export const modelBaseUrl = () => process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1/";
export const isOpenRouter = (baseUrl: string) => baseUrl.includes("openrouter.ai");

const endpointsUrl = (model: string) => `https://openrouter.ai/api/v1/models/${model}/endpoints`;

// The profile lets the harness try almost any model without per-model flags:
// refuse a model nothing serves with tools, send `reasoning` only where it's
// accepted, and keep the turn budget under what providers will generate.
// It can't tell *how* a model honours reasoning controls; the attempt learns
// that from what comes back (see reasoning-ladder.ts).
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
 * flags decide. An unknown slug (404) or a model no provider serves comes back
 * with supportsTools false, so the goal fails at once.
 */
export async function modelProfile(model: string, baseUrl: string): Promise<ModelProfile & { known: boolean }> {
  if (!isOpenRouter(baseUrl)) return { ...permissive, known: false };
  let eps: Endpoint[];
  try {
    const r = await fetch(endpointsUrl(model));
    if (r.status === 404) return { ...permissive, supportsTools: false, missing: true, known: true };
    if (!r.ok) return { ...permissive, known: false };
    eps = ((await r.json()) as { data?: { endpoints?: Endpoint[] } }).data?.endpoints ?? [];
  } catch {
    return { ...permissive, known: false };
  }
  // Listed, but no provider serves it any more.
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

const cache = new Map<string, Promise<Pick<Endpoint, "provider_name" | "context_length">[]>>();

function endpoints(model: string) {
  let p = cache.get(model);
  if (!p) {
    p = fetch(endpointsUrl(model))
      .then((r) => (r.ok ? r.json() : { data: { endpoints: [] } }))
      .then((j: { data?: { endpoints?: Endpoint[] } }) => j.data?.endpoints ?? [])
      .catch(() => []);
    cache.set(model, p);
  }
  return p;
}

/**
 * Context window of a model as served by a given provider (providers can serve
 * the same model with different limits). Undefined if it can't be found
 * (another endpoint, offline); the meter then shows raw token counts.
 */
export async function contextWindow(model: string, provider?: string): Promise<number | undefined> {
  if (!isOpenRouter(modelBaseUrl())) return undefined;
  const eps = await endpoints(model);
  const exact = eps.find((e) => e.provider_name === provider)?.context_length;
  if (exact) return exact;
  // Unknown provider: the smallest window any provider serves (conservative).
  const all = eps.map((e) => e.context_length).filter((n) => n > 0);
  return all.length ? Math.min(...all) : undefined;
}
