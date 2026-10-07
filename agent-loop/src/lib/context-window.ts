// Context window of a model as served by a given provider, from OpenRouter's
// public endpoints API (no key needed). Providers can serve the same model
// with different limits, so look up the one that served the turn. Used by
// `pnpm goal:watch` for the context meter; undefined if it can't be found
// (another endpoint, offline), and the meter shows raw token counts instead.
type Endpoint = { provider_name: string; context_length: number };

const cache = new Map<string, Promise<Endpoint[]>>();

function endpoints(model: string): Promise<Endpoint[]> {
  let p = cache.get(model);
  if (!p) {
    p = fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`)
      .then((r) => (r.ok ? r.json() : { data: { endpoints: [] } }))
      .then((j: { data?: { endpoints?: Endpoint[] } }) => j.data?.endpoints ?? [])
      .catch(() => []);
    cache.set(model, p);
  }
  return p;
}

export async function contextWindow(model: string, provider?: string): Promise<number | undefined> {
  const baseUrl = process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1/";
  if (!baseUrl.includes("openrouter.ai")) return undefined;
  const eps = await endpoints(model);
  const exact = eps.find((e) => e.provider_name === provider)?.context_length;
  if (exact) return exact;
  // Unknown provider: the smallest window any provider serves (conservative).
  const all = eps.map((e) => e.context_length).filter((n) => n > 0);
  return all.length ? Math.min(...all) : undefined;
}
