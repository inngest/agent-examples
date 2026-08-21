import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The benchmark config (config/benchmark.yaml) is the single source of truth
// for the run matrix: which models compete, their generation params, pricing,
// and the shared prompt. Everything here is pinned data — the harness code
// never hardcodes a model string or price.

export const GenerationParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2),
    top_p: z.number().min(0).max(1),
    max_tokens: z.number().int().positive(),
    // OpenRouter reasoning-effort control for hybrid reasoning models
    // (openrouter adapter only). Unset = provider default. Recorded in
    // every result row.
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
    // MiniMax M3 thinking toggle (spec v3 §7): decided once (Δ4 A/A run),
    // applied identically across batch and live runs, recorded on every
    // result row. Absent = the model has no such toggle (the baseline).
    thinking: z.boolean().optional(),
  })
  .strict();

export const ModelConfigSchema = z
  .object({
    // Identity string recorded in every result row. Encode provider +
    // served precision here so results are never ambiguous (spec v3 §10),
    // e.g. minimax-m3-fp8-nebius.
    id: z.string().min(1),
    // "openai_compat": any OpenAI-compatible endpoint (v3 contender path —
    // MiniMax M3 on Nebius Token Factory). "openrouter": the v2 baseline
    // path, kept so committed runs stay reproducible.
    adapter: z.enum(["openai_compat", "openrouter"]),
    // The model string actually called on the provider's API.
    model: z.string().min(1),
    // Base URL of the OpenAI-compatible API. Supports ${ENV_VAR}
    // interpolation (spec v3 §11 syntax), expanded at load. Unset = the
    // adapter's built-in default (see src/models/adapter.ts).
    endpoint: z.string().min(1).optional(),
    // Which env var holds this provider's API key. Unset = the adapter's
    // built-in default.
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    // Max parallel samples for this model (provider rate limits).
    concurrency: z.number().int().positive().default(4),
    params: GenerationParamsSchema,
    // USD per 1M tokens, pinned from the provider's rate card at setup and
    // snapshotted into every run's metadata (spec v3 §8.5/§10) so committed
    // cost numbers stay auditable if pricing changes.
    pricing: z
      .object({
        input_per_mtok: z.number().min(0),
        output_per_mtok: z.number().min(0),
      })
      .strict(),
  })
  .strict();

// Multi-file response contract (spec v2 §7): the agentic-loop format both
// models must use. Defaults live here so every run records the exact
// contract; a yaml override replaces it wholesale (and is recorded too).
export const DEFAULT_FILE_FORMAT = `
## Response format

Return every file you create or change, each in exactly this format:

--- <relative/path.go> ---
<complete file contents of that file>
--- <another/path.go> ---
<complete file contents>

Rules:
- One \`--- <path> ---\` marker line starts each file; the next marker (or the
  end of your reply) ends it. No prose outside the markers.
- Always return the COMPLETE contents of each file you touch — never diffs,
  never "... rest unchanged".
- Use the exact relative path from the repository root.
`;

export const DEFAULT_FIX_SUFFIX = `
Fix the problem shown above and return the corrected file(s) using the same
--- <path> --- marker format. Return complete files, not diffs. You may
change any file, but return only files that need to change.
`;

export const BenchmarkConfigSchema = z
  .object({
    run: z
      .object({
        k_samples: z.number().int().positive(),
        seed_policy: z.enum(["vary", "fixed"]),
        // Optional task-id subset (spec v3 Δ4: the thinking A/A run uses a
        // small slice). Unset = the full suite.
        tasks: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    models: z.array(ModelConfigSchema).min(1),
    prompting: z
      .object({
        system: z.string().min(1),
        user_suffix: z.string(),
        file_format: z.string().default(DEFAULT_FILE_FORMAT),
        fix_suffix: z.string().default(DEFAULT_FIX_SUFFIX),
      })
      .strict(),
    sandbox: z
      .object({
        // "inngest": real isolation via the Sandboxes beta (cloud-only; the
        // fixed image is probed for the language toolchain at open — Go
        // works iff the image ships a Go toolchain). "local": host
        // execution in named session dirs (dev mode — timeouts + scrubbed
        // env, no isolation). "stub": all-null sandbox fields, rows stay
        // pending.
        runner: z.enum(["inngest", "local", "stub"]).default("stub"),
        default_timeout_seconds: z.number().int().positive().default(60),
      })
      .strict(),
  })
  .strict();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export const CONFIG_PATH =
  process.env.BENCHMARK_CONFIG ??
  new URL("../config/benchmark.yaml", import.meta.url).pathname;

// Expands ${ENV_VAR} references in config strings (spec v3 §11 endpoint
// syntax). Fails at load time with the variable name — a silently empty
// base URL would surface much later as a confusing request error.
export function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (!resolved) {
      throw new Error(`config references unset env var: ${name} (set it in .env — see .env.example)`);
    }
    return resolved;
  });
}

// Loaded once at module scope: the config is static data needed at function
// definition time (per-model concurrency limits and trigger filters are baked
// into the generated execute-sample functions).
export function loadConfig(path = CONFIG_PATH): BenchmarkConfig {
  const parsed = BenchmarkConfigSchema.parse(parseYaml(readFileSync(path, "utf8")));
  const ids = new Set<string>();
  for (const model of parsed.models) {
    if (ids.has(model.id)) throw new Error(`duplicate model id in ${path}: ${model.id}`);
    ids.add(model.id);
    if (model.endpoint) model.endpoint = expandEnvRefs(model.endpoint);
  }
  return parsed;
}

export const config = loadConfig();

// Resolves {entrypoint} placeholders in the shared prompt templates.
export function renderTemplate(template: string, entrypoint: string): string {
  return template.replaceAll("{entrypoint}", entrypoint);
}

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
