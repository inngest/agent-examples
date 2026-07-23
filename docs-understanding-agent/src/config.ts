const decodePrivateKey = (raw: string): string => {
  if (!raw || raw.includes("-----BEGIN")) return raw;
  return Buffer.from(raw, "base64").toString("utf8");
};

export type ModelSpec = { id: string; variant: string };

// "anthropic/claude-sonnet-4.5" -> variant "claude-sonnet-4.5". Two ids that
// share a suffix (rare, but possible with custom OpenRouter routes) fall back
// to the full id with slashes turned into dashes so variants stay unique.
export function parseModels(raw: string): ModelSpec[] {
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("MODELS must contain at least one model id");

  const seen = new Set<string>();
  return ids.map((id) => {
    let variant = id.split("/").pop() || id;
    if (seen.has(variant)) variant = id.replace(/\//g, "-");
    seen.add(variant);
    return { id, variant };
  });
}

export type ExperimentMode = "sample" | "compare";

export function parseMode(raw: string | undefined): ExperimentMode {
  const mode = raw ?? "sample";
  if (mode !== "sample" && mode !== "compare") {
    throw new Error(`EXPERIMENT_MODE must be "sample" or "compare", got "${mode}"`);
  }
  return mode;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  },

  // Fixed model for the LLM-judge scoring pass (kept out of the experiment so
  // judge quality doesn't vary with the variant under test).
  judgeModel: process.env.JUDGE_MODEL ?? "google/gemini-3.5-flash",

  // sample: one model per page, weighted A/B (today's behavior). compare: all
  // models on every page, side-by-side.
  experimentMode: parseMode(process.env.EXPERIMENT_MODE),
  models: parseModels(process.env.MODELS ?? "anthropic/claude-sonnet-4.5,openai/gpt-4o"),

  docsPathPrefixes: (process.env.DOCS_PATH_PREFIXES ?? "docs/,blog/,content/")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
  docsContentRoot: process.env.DOCS_CONTENT_ROOT ?? "",
  maxPages: Number(process.env.MAX_PAGES ?? 5),

  previewBypassSecret: process.env.PREVIEW_BYPASS_SECRET,

  dryRunGithub: process.env.DRY_RUN_GITHUB === "1",
  github: {
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKey: decodePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY ?? ""),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
};
