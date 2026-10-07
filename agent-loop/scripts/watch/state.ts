// What the watcher knows about the goal, and how history and live messages
// change it. No rendering here: render.ts draws whatever this holds.
//
// History (the REST events API) comes first, then live Realtime messages.
// The two overlap, so live messages are deduplicated: by attempt number for
// scored rows, and by step (turn, tool call) within the running attempt.
import type { AttemptMessage, LoopMessage, ScoredMessage } from "../../src/inngest/channel.js";
import { GOAL_DEFAULTS } from "../../src/inngest/events.js";
import type { GoalHistory } from "../../src/lib/goal-history.js";
import type { GoalOptions } from "../../src/lib/start-goal.js";
import { contextWindow } from "../../src/lib/openrouter.js";
import { c } from "./format.js";

// One turn, tool call or refused finish of the running attempt.
export type Step = Exclude<AttemptMessage, { type: "attempt.started" }>;

export type CurrentAttempt = {
  i: number;
  since: number;
  steps: Step[];
  seen: Set<string>;
  // The first turn's budget, to show when the reasoning ladder raises it.
  budget0?: number;
  // Context in use after the latest turn (its prompt + its output), who
  // served it, and that provider's window for the model.
  ctx?: number;
  provider?: string;
  window?: number;
};

export type WatchState = ReturnType<typeof createState>;

export function createState(goalArgs: Partial<GoalOptions>) {
  return {
    // From the goal's history once loaded; until then, what `s` would start.
    model: goalArgs.model,
    maxAttempts: goalArgs.maxAttempts ?? (GOAL_DEFAULTS.maxAttempts as number),
    maxStalls: goalArgs.maxStalls ?? (GOAL_DEFAULTS.maxStalls as number),
    rows: new Map<number, ScoredMessage>(),
    current: undefined as CurrentAttempt | undefined,
    // Peak context per attempt, as a share of the window (live data only).
    peakCtx: new Map<number, number>(),
    // Paused for review: the review pane and editor are up.
    waiting: false,
    lastNote: "",
    // The best attempt's check report: shown in the review pane.
    bestReport: "",
    finished: undefined as Extract<LoopMessage, { type: "goal.finished" }> | undefined,
    // Connection status for the header (already coloured).
    conn: "loading history…",
    // One-line status above the key hints (already coloured).
    flash: "",
    // A run of this goal is in flight (started and not finished).
    running: false,
    starting: false,
  };
}

// Scored attempts, oldest first.
export const sortedRows = (s: WatchState) => [...s.rows.values()].sort((a, b) => a.i - b.i);

// Returns true when the goal is paused for review (the caller shows the editor).
export function applyHistory(s: WatchState, h: GoalHistory): boolean {
  s.model = h.model ?? s.model;
  s.maxAttempts = h.maxAttempts ?? s.maxAttempts;
  s.maxStalls = h.maxStalls ?? s.maxStalls;
  for (const r of h.rows) s.rows.set(r.i, r);
  s.lastNote = h.lastNote ?? "";
  s.bestReport = h.bestReport ?? "";
  if (h.finished) s.finished = { type: "goal.finished", ...h.finished };
  s.running = h.startedAt !== undefined && !h.finished;
  return h.waiting;
}

// A `goal/started` was just sent from here. The worker's goal.started arrives
// only after the baseline is scored, so clear the old run now.
export function applyStartSent(s: WatchState, goalArgs: Partial<GoalOptions>) {
  s.rows.clear();
  s.current = undefined;
  s.finished = undefined;
  s.running = true;
  s.maxAttempts = goalArgs.maxAttempts ?? GOAL_DEFAULTS.maxAttempts;
  s.maxStalls = goalArgs.maxStalls ?? GOAL_DEFAULTS.maxStalls;
  s.model = goalArgs.model ?? s.model;
}

// Returns what the review editor should do; the caller owns the editor.
export function applyLoop(s: WatchState, m: LoopMessage): "show-review" | "hide-review" | undefined {
  switch (m.type) {
    case "goal.started":
      s.running = true;
      s.model = m.model;
      s.maxAttempts = m.maxAttempts;
      s.maxStalls = m.maxStalls;
      s.rows.clear();
      s.finished = undefined;
      s.waiting = false;
      return;
    case "attempt.scored":
      s.rows.set(m.i, m);
      if (s.current?.i === m.i) s.current = undefined;
      return;
    case "review.waiting":
      s.bestReport = m.report;
      return "show-review";
    case "review.resumed":
      if (m.note) s.lastNote = m.note;
      return "hide-review";
    case "goal.failed":
      s.running = false;
      s.current = undefined;
      s.flash = c.red(`goal failed: ${m.reason}`);
      return;
    case "goal.finished":
      s.running = false;
      s.finished = m;
      s.current = undefined;
      return "hide-review";
  }
}

const stepKey = (m: AttemptMessage) =>
  m.type === "tool" ? `tool-${m.t}-${m.n}` : m.type === "turn" ? `turn-${m.t}` : m.type === "finish.refused" ? `ref-${m.t}` : "start";

// `changed` is called when the context window lookup (async) lands.
export function applyAttempt(s: WatchState, m: AttemptMessage, changed: () => void) {
  if (s.rows.has(m.i)) return; // already scored: a late or replayed message
  if (s.current?.i !== m.i) s.current = { i: m.i, since: Date.now(), steps: [], seen: new Set() };
  const cur = s.current;
  const key = stepKey(m);
  if (cur.seen.has(key)) return;
  cur.seen.add(key);
  if (m.type === "attempt.started") return;

  if (m.type === "turn") {
    if (m.inputTokens) {
      cur.ctx = m.inputTokens + m.outputTokens;
      cur.provider = m.provider ?? cur.provider;
      trackContext(s, m.i, cur.ctx, cur.provider, changed);
    }
    cur.budget0 ??= m.maxTokens;
  }
  cur.steps.push(m);
}

// Look up the provider's window, then record the meter's denominator and the
// attempt's peak share for the table.
function trackContext(s: WatchState, i: number, used: number, provider: string | undefined, changed: () => void) {
  void contextWindow(s.model ?? "", provider).then((w) => {
    if (!w) return;
    if (s.current?.i === i) s.current.window = w;
    s.peakCtx.set(i, Math.max(s.peakCtx.get(i) ?? 0, used / w));
    changed();
  });
}
