import OpenAI from "openai";
import type { BenchmarkConfig, ModelConfig } from "../config";
import { renderTemplate } from "../config";
import { extractCode } from "../extract";
import { loadDirFiles, workspaceDir, type Task } from "../tasks";

// One adapter interface over every contender. Two implementations of the
// same OpenAI chat-completions protocol: "openai_compat" for the contender
// — MiniMax M3 on Nebius Token Factory — and "openrouter" for the Sonnet
// baseline. The seam stays so a future contender (first-party MiniMax,
// direct Anthropic, local weights) drops in without touching the
// functions.

export type GenerationRequest = {
  system: string;
  user: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
  thinking?: boolean;
  seed?: number;
};

// Everything JSON-safe: this value is memoized inside a step.run, so a
// retried run replays it without re-calling the model.
export type GenerationResult = {
  raw: string;
  extracted: boolean;
  code: string;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  latencyMs: number;
  costUsd: number | null;
  // M3-on-Nebius streams an out-of-band `reasoning_content` channel: size
  // in chars, recorded per turn so A/A runs can quantify thinking verbosity.
  // 0 for models without the channel (the baseline).
  reasoningChars: number;
};

export interface ModelAdapter {
  readonly modelId: string;
  generate(req: GenerationRequest): Promise<GenerationResult>;
}

export function createAdapter(model: ModelConfig): ModelAdapter {
  switch (model.adapter) {
    case "openai_compat":
    case "openrouter":
      // Both speak the OpenAI chat-completions protocol; the deltas are
      // endpoint/auth (config) and the provider extras attached in generate.
      return openAiCompatAdapter(model);
  }
}

// The identical prompt both models receive, built once here so there is
// exactly one place where prompt construction can diverge (it must not).
// Turn-aware: turn 1 states the task (plus the seed codebase for
// agentic_fileops tasks); later turns replay the previous attempt and its
// failure output so the model can fix what it broke.

export type TurnContext = {
  turn: number;
  // Turn >1 feedback: the files the model wrote last turn…
  prevFiles: Record<string, string> | null;
  // …and why they failed (sandbox output or a parse error).
  prevFeedback: string | null;
};

const FEEDBACK_FILE_BYTES = 8 * 1024;
const FEEDBACK_TOTAL_BYTES = 32 * 1024;
const FEEDBACK_OUTPUT_BYTES = 6 * 1024;

function renderFilesBlock(files: Record<string, string>): string {
  const parts: string[] = [];
  let total = 0;
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    const capped =
      content.length > FEEDBACK_FILE_BYTES ? content.slice(0, FEEDBACK_FILE_BYTES) + "\n…[truncated]" : content;
    if (total + capped.length > FEEDBACK_TOTAL_BYTES) {
      parts.push(`--- ${path} ---\n…[omitted from context: feedback budget exhausted]`);
      continue;
    }
    total += capped.length;
    parts.push(`--- ${path} ---\n${capped}`);
  }
  return parts.join("\n\n");
}

function tail(s: string, bytes: number): string {
  return s.length > bytes ? "…[truncated]\n" + s.slice(-bytes) : s;
}

function firstTurnUser(task: Task, cfg: BenchmarkConfig): string {
  const entrypoint = task.entrypoint || "your files";
  const base = `${task.prompt.trim()}\n\n${renderTemplate(cfg.prompting.user_suffix, entrypoint).trim()}`;
  if (task.task_type !== "agentic_fileops") return base;

  const wsDir = workspaceDir(task);
  const seed = wsDir ? loadDirFiles(wsDir) : {};
  const tree = Object.keys(seed).sort().map((p) => `- ${p}`).join("\n");
  return (
    `## Existing codebase\n\nFiles present in the repository:\n\n${tree}\n\n` +
    `${renderFilesBlock(seed)}\n\n${base}\n\n${cfg.prompting.file_format.trim()}`
  );
}

export function buildGenerationRequest(
  task: Task,
  model: ModelConfig,
  cfg: BenchmarkConfig,
  seed: number | undefined,
  ctx: TurnContext,
): GenerationRequest {
  let user = firstTurnUser(task, cfg);
  if (ctx.turn > 1 && ctx.prevFiles && Object.keys(ctx.prevFiles).length > 0) {
    user +=
      `\n\n## Your previous attempt (turn ${ctx.turn - 1})\n\n` +
      `Files you submitted:\n\n${renderFilesBlock(ctx.prevFiles)}\n\n`;
    if (ctx.prevFeedback) {
      user += `Result: FAILED. Output:\n\n\`\`\`\n${tail(ctx.prevFeedback, FEEDBACK_OUTPUT_BYTES)}\n\`\`\`\n\n`;
    }
    user += cfg.prompting.fix_suffix.trim();
  }
  return {
    system: renderTemplate(cfg.prompting.system, task.entrypoint || "the requested files"),
    user,
    temperature: model.params.temperature,
    topP: model.params.top_p,
    maxTokens: model.params.max_tokens,
    reasoningEffort: model.params.reasoning_effort,
    thinking: model.params.thinking,
    seed,
  };
}

// -- OpenAI-compatible adapters (Nebius / OpenRouter) ------------------------

// Where a model's requests actually go. Config wins; these are the
// per-adapter defaults so the same providerTarget() resolves endpoints for
// the smoke script without duplicating the fallback chain.
const ADAPTER_DEFAULTS = {
  // Nebius Token Factory, OpenAI-compatible API (the contender path).
  openai_compat: { endpoint: "https://api.tokenfactory.nebius.com/v1/", apiKeyEnv: "NEBIUS_API_KEY" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
} as const;

export type ProviderTarget = { baseURL: string; apiKeyEnv: string };

export function providerTarget(model: ModelConfig): ProviderTarget {
  const def = ADAPTER_DEFAULTS[model.adapter];
  const baseURL =
    model.endpoint ??
    (model.adapter === "openrouter" ? process.env.OPENROUTER_BASE_URL : undefined) ??
    def.endpoint;
  return { baseURL, apiKeyEnv: model.api_key_env ?? def.apiKeyEnv };
}

// One client per (baseURL, key env): a run can now span two providers
// (Nebius for the contender, OpenRouter for the baseline), so a module
// singleton won't do. Lazily constructed so the app boots keyless (config
// validation, task loading, sandbox smoke tests) — the key is only required
// at generate time.
const _clients = new Map<string, OpenAI>();

function clientFor(target: ProviderTarget): OpenAI {
  const cacheKey = `${target.baseURL}|${target.apiKeyEnv}`;
  let client = _clients.get(cacheKey);
  if (!client) {
    const apiKey = process.env[target.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`${target.apiKeyEnv} is required for ${target.baseURL} (see .env.example)`);
    }
    client = new OpenAI({ apiKey, baseURL: target.baseURL });
    _clients.set(cacheKey, client);
  }
  return client;
}

// OpenRouter's usage carries an extra `cost` field on some plans; recorded
// when present as a cross-check against the config-pinned pricing. Nebius
// omits it, so pinned pricing applies there.
type UsageWithCost = { cost?: number };

type StreamParams = Parameters<OpenAI["chat"]["completions"]["stream"]>[0];

// MiniMax M3's thinking toggle — wire spelling confirmed by token-level
// probes against tokenfactory.nebius.com (2026-08-21):
//
// - A literal `thinking: true|false` body param is ACCEPTED but IGNORED —
//   no 400, no effect; M3 reasons by default either way.
// - `enable_thinking`, `chat_template_kwargs.enable_thinking`,
//   `reasoning: {enabled|exclude}` — same silent no-op.
// - `reasoning_effort: "none"` is the only spelling that suppresses
//   reasoning (0 reasoning_content chars across repeats; every other value
//   or an omitted param leaves it on).
//
// So: thinking=false → reasoning_effort "none"; thinking=true → omit the
// param (provider default = thinking on). Nebius's usage chunk reports
// `reasoning_tokens: 0` even while reasoning streams — but `completion_tokens`
// INCLUDES the reasoning tokens, so output-token cost math stays honest.
function applyThinking(params: StreamParams, thinking: boolean | undefined): void {
  if (thinking === undefined || thinking === true) return;
  Object.assign(params, { reasoning_effort: "none" });
}

function openAiCompatAdapter(model: ModelConfig): ModelAdapter {
  const target = providerTarget(model);
  return {
    modelId: model.id,
    async generate(req) {
      const startedAt = Date.now();
      // First/last token across BOTH channels (content and reasoning_content):
      // a reasoning model streams its thinking preamble before any content, so
      // first-content-token TTFT and content-phase tok/s would understate the
      // wait and inflate throughput (confirmed by streaming probes on the
      // Nebius endpoint). For non-reasoning models (the baseline) the
      // reasoning channel never fires and nothing changes.
      let firstTokenAt: number | null = null;
      let lastTokenAt: number | null = null;
      let raw = "";
      let reasoningChars = 0;
      let tokensPrompt: number | null = null;
      let tokensCompletion: number | null = null;
      let nativeCostUsd: number | null = null;

      // Built as the typed streaming-params object first so the SDK resolves
      // the streaming overload; provider-only extras (thinking, OpenRouter
      // reasoning) attach at runtime and ride along transparently. The params
      // type is derived from the .stream() signature rather than a deep type
      // import.
      const params: StreamParams = {
        model: model.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature,
        top_p: req.topP,
        max_tokens: req.maxTokens,
        // Pass-through: providers forward `seed` only where supported —
        // OpenRouter forwards to backing providers that accept it; Nebius's
        // handling was checked in the endpoint smoke test. Recorded per row
        // either way; see FINDINGS.md ("Known caveats").
        seed: req.seed,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (model.adapter === "openrouter" && req.reasoningEffort) {
        // OpenRouter's reasoning-effort control (`reasoning: { effort }`).
        Object.assign(params, { reasoning: { effort: req.reasoningEffort } });
      }
      applyThinking(params, req.thinking);

      const stream = clientFor(target).chat.completions.stream(params);

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta as
          | { content?: string | null; reasoning_content?: string | null }
          | undefined;
        if (delta?.reasoning_content) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          lastTokenAt = Date.now();
          reasoningChars += delta.reasoning_content.length;
        }
        if (delta?.content) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          lastTokenAt = Date.now();
          raw += delta.content;
        }
        if (chunk.usage) {
          tokensPrompt = chunk.usage.prompt_tokens ?? null;
          tokensCompletion = chunk.usage.completion_tokens ?? null;
          const reported = (chunk.usage as UsageWithCost).cost;
          if (typeof reported === "number") nativeCostUsd = reported;
        }
      }

      const latencyMs = Date.now() - startedAt;
      const { code, extracted } = extractCode(raw);

      // tokens/sec measures the generation phase (first token to last token,
      // both channels), not the full request — prompt processing shouldn't
      // dilute it. Short replies that arrive in one buffered burst have a
      // zero-width window: tok/s is null rather than fabricated (short
      // Nebius responses can land in a single flush).
      let tokensPerSec: number | null = null;
      const genWindowMs =
        firstTokenAt !== null && lastTokenAt !== null ? lastTokenAt - firstTokenAt : 0;
      if (tokensCompletion !== null && genWindowMs > 0) {
        tokensPerSec = tokensCompletion / (genWindowMs / 1000);
      }

      // Config-pinned pricing is the default; OpenRouter's reported cost
      // (when present) wins, since it's the authoritative charge.
      let costUsd: number | null = null;
      if (tokensPrompt !== null && tokensCompletion !== null) {
        costUsd =
          (tokensPrompt / 1_000_000) * model.pricing.input_per_mtok +
          (tokensCompletion / 1_000_000) * model.pricing.output_per_mtok;
      }
      if (nativeCostUsd !== null) costUsd = nativeCostUsd;

      return {
        raw,
        extracted,
        code,
        tokensPrompt,
        tokensCompletion,
        ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
        tokensPerSec,
        latencyMs,
        costUsd,
        reasoningChars,
      };
    },
  };
}
