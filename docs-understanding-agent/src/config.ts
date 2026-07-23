const decodePrivateKey = (raw: string): string => {
  if (!raw || raw.includes("-----BEGIN")) return raw;
  return Buffer.from(raw, "base64").toString("utf8");
};

export const config = {
  port: Number(process.env.PORT ?? 3000),

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  },

  // Fixed model for the LLM-judge scoring pass (kept out of the experiment so
  // judge quality doesn't vary with the variant under test).
  judgeModel: process.env.JUDGE_MODEL ?? "google/gemini-2.0-flash-001",

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
