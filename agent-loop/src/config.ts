// Everything a goal is tuned by. GOAL_DEFAULTS are what goal/started leaves
// out (v4 event schemas can't apply `.default()`); the rest are fixed limits.

/** What a goal uses when goal/started doesn't say. */
export const GOAL_DEFAULTS = {
  maxAttempts: 60,
  maxStalls: 5,
  maxTurnsPerAttempt: 8,
  maxTokensPerTurn: 4000,
} as const;

/**
 * The "brief" experiment's variants: what each changes about every brief.
 * `control` is the defaults. A goal with no variant takes these from goal/started.
 */
export const BRIEF_VARIANTS = {
  control: {},
  spec: { spec: true },
  examples: { examplesPerBrief: 30 },
  no_focus: { focus: false },
} as const;

/** The commit every goal starts from: the stubs, tagged in the work sandbox's setup. */
export const STUB = "stub";

/** The model when neither goal/started nor the MODEL env var names one. */
export const DEFAULT_MODEL = "qwen/qwen3-coder-30b-a3b-instruct";

/**
 * The most attempts a goal makes. A run has at most 1,000 steps, and an
 * attempt takes about 12 of the goal's (its own turns are steps of the coder's run).
 */
export const MAX_ATTEMPTS = 70;

/** The most a turn's output budget grows to when the model's providers state no limit. */
export const MAX_TOKENS_CAP = 32_000;

/** How long the grader runs one candidate against the cases. */
export const GRADER_TIMEOUT_MS = 60_000;

/** The brief: recent attempts it shows, failing examples per brief, and how much code it inlines. */
export const JOURNAL_SIZE = 5;
export const EXAMPLES_PER_BRIEF = 10;
export const MAX_CODE_CHARS = 20_000;
