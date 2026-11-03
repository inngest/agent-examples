// A goal's settings: everything it runs by, resolved once. The goal reads them
// in a step, so a redeploy with another MODEL, REASONING_* or spec.txt can't
// change a goal that's already running.
import fs from "node:fs";
import path from "node:path";
import { BRIEF_VARIANTS, DEFAULT_MODEL, GOAL_DEFAULTS, MAX_ATTEMPTS, MAX_TOKENS_CAP } from "../config.js";
import type { goalStarted } from "../inngest/events.js";
import { modelBaseUrl, modelProfile, type ModelProfile } from "./openrouter.js";
import { DATA_DIR } from "./paths.js";

type GoalData = ReturnType<typeof goalStarted.create>["data"];
type BriefOptions = { focus?: boolean; spec?: boolean; examplesPerBrief?: number };

export async function goalSettings(data: GoalData) {
  const slug = data.model ?? (process.env.MODEL || DEFAULT_MODEL);
  const profile = await modelProfile(slug, modelBaseUrl());
  const maxTokensCap = Math.min(profile.maxCompletionTokens ?? MAX_TOKENS_CAP, MAX_TOKENS_CAP);
  const brief = briefOptions(data);

  return {
    unusable: unusable(slug, profile),
    maxAttempts: Math.min(data.maxAttempts ?? GOAL_DEFAULTS.maxAttempts, MAX_ATTEMPTS),
    maxStalls: data.maxStalls ?? GOAL_DEFAULTS.maxStalls,
    maxTurns: data.maxTurnsPerAttempt ?? GOAL_DEFAULTS.maxTurnsPerAttempt,
    brief: { focus: brief.focus ?? true, examplesPerBrief: brief.examplesPerBrief, specText: spec(brief) },
    model: {
      slug,
      maxTokensPerTurn: Math.min(data.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn, maxTokensCap),
      maxTokensCap,
      supportsReasoning: profile.supportsReasoning,
      ...reasoning(data, profile),
    },
  };
}

export type GoalSettings = Awaited<ReturnType<typeof goalSettings>>;

/** Why the goal can't run with this model, if it can't. */
function unusable(slug: string, profile: ModelProfile): string | undefined {
  if (profile.missing) return `${slug} isn't a model on OpenRouter (check the slug)`;
  if (!profile.supportsTools) return `${slug}: no OpenRouter provider serves it with tools and tool_choice, which the loop needs`;
  return undefined;
}

/** A variant's brief options win over the event's. */
function briefOptions(data: GoalData): BriefOptions {
  if (data.variant) return BRIEF_VARIANTS[data.variant];
  return data;
}

/** Go's documentation for the package, when the brief includes it. */
function spec(brief: BriefOptions): string | undefined {
  if (!brief.spec) return undefined;
  return fs.readFileSync(path.join(DATA_DIR, "spec.txt"), "utf8");
}

/** Reasoning controls: opt-in, from the event or REASONING_*, and only for a model that takes them. */
function reasoning(data: GoalData, profile: ModelProfile) {
  if (!profile.supportsReasoning) return {};
  const envEffort = (["low", "medium", "high"] as const).find((e) => e === process.env.REASONING_EFFORT?.trim().toLowerCase());
  return {
    reasoningEffort: data.reasoningEffort ?? envEffort,
    reasoningMaxTokens: data.reasoningMaxTokens ?? positiveInt(process.env.REASONING_MAX_TOKENS),
  };
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  return undefined;
}
