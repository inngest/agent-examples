// pnpm goal:watch -- --goal <id> [--dev | --cloud] [--start] [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N] [--reasoning-effort low|medium|high] [--reasoning-max-tokens N]
// Live terminal view of one goal: the score per attempt, keep/revert, the
// stall counter, the attempt in flight (turns and tool calls), and, when the
// loop pauses for review, an editor to send the note (or stop) from here.
// When no run of the goal is in flight, `s` (or --start) starts one with the
// goal flags given (the same ones `goal:send` takes); on the local backend
// the workspace is reset first, as before any new goal.
// Target: INNGEST_DEV from .env (dev server) or Inngest Cloud; --dev / --cloud
// override it for this session.
// Quitting only closes the subscription; the run never depends on a watcher.
import { isDevTarget, targetLabel } from "./watch-target.js"; // must stay first: sets INNGEST_DEV
import { Editor, matchesKey, ProcessTerminal, TUI, truncateToWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import { subscribe } from "inngest/realtime";
import { inngest } from "../src/inngest/client.js";
import { GOAL_DEFAULTS, goalReviewSubmitted } from "../src/inngest/events.js";
import { goalChannel, type AttemptMessage, type AttemptOutcome, type LoopMessage, type ScoredMessage } from "../src/inngest/channel.js";
import { loadGoalHistory } from "../src/lib/goal-history.js";
import { contextWindow } from "../src/lib/context-window.js";
import { parseGoalArgs, startGoal } from "../src/lib/start-goal.js";
import { resetWorkspace } from "../src/lib/reset-workspace.js";
import { backend } from "../src/lib/backend.js";

const argv = process.argv.slice(2);
const goalArgs = parseGoalArgs(argv);
const goalId = goalArgs.goalId;
if (!goalId) {
  console.error("usage: pnpm goal:watch -- --goal <id> [--dev | --cloud] [--start] [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N] [--reasoning-effort low|medium|high] [--reasoning-max-tokens N] [--no-focus] [--inline]");
  process.exit(2);
}

// --- colours (pi-tui resets styles at the end of every line) ---
const sgr = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const c = { dim: sgr("2"), bold: sgr("1"), green: sgr("32"), yellow: sgr("33"), red: sgr("31"), cyan: sgr("36"), magenta: sgr("35") };
const outcomeColour: Record<AttemptOutcome, (s: string) => string> = { kept: c.green, reverted: c.yellow, unchanged: c.dim, failed: c.red };

// --- state ---
const state = {
  // From the goal's history once loaded; until then, what `s` would start.
  model: goalArgs.model,
  maxAttempts: goalArgs.maxAttempts ?? (GOAL_DEFAULTS.maxAttempts as number),
  maxStalls: goalArgs.maxStalls ?? (GOAL_DEFAULTS.maxStalls as number),
  rows: new Map<number, ScoredMessage>(),
  current: undefined as
    | {
        i: number;
        since: number;
        lines: string[];
        seen: Set<string>;
        // Context in use after the latest turn (its prompt + its output), who
        // served it, and that provider's window for the model.
        ctx?: number;
        provider?: string;
        window?: number;
      }
    | undefined,
  // Peak context per attempt, as a share of the window (live data only).
  peakCtx: new Map<number, number>(),
  waiting: false,
  lastNote: "",
  // The best attempt's check report: shown in the review pane.
  bestReport: "",
  finished: undefined as Extract<LoopMessage, { type: "goal.finished" }> | undefined,
  conn: "loading history…",
  flash: "",
  // A run of this goal is in flight (started and not finished).
  running: false,
  starting: false,
};

const sorted = () => [...state.rows.values()].sort((a, b) => a.i - b.i);
const lastRow = () => sorted().at(-1);
const totalCost = () => sorted().reduce((s, r) => s + r.costUsd, 0);
const fmtScore = (s: number) => s.toFixed(3);
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
function meter(used: number, window: number, cells = 12) {
  const share = Math.min(1, used / window);
  const filled = Math.round(share * cells);
  const colour = share > 0.8 ? c.red : share > 0.5 ? c.yellow : c.green;
  return `${colour("█".repeat(filled))}${c.dim("░".repeat(cells - filled))} ${kTok(used)} / ${kTok(window)} (${Math.round(share * 100)}%)`;
}
const ago = (ms: number) => {
  const s = Math.floor((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

function startAttempt(i: number) {
  if (state.current?.i === i) return;
  state.current = { i, since: Date.now(), lines: [], seen: new Set() };
}

function onAttempt(m: AttemptMessage) {
  if (state.rows.has(m.i)) return; // already scored: a late or replayed message
  startAttempt(m.i);
  const cur = state.current!;
  const key = m.type === "tool" ? `tool-${m.t}-${m.n}` : m.type === "turn" ? `turn-${m.t}` : m.type === "finish.refused" ? `ref-${m.t}` : "start";
  if (cur.seen.has(key)) return;
  cur.seen.add(key);
  if (m.type === "turn") {
    if (m.inputTokens) {
      cur.ctx = m.inputTokens + m.outputTokens;
      cur.provider = m.provider ?? cur.provider;
      const i = m.i;
      const used = cur.ctx;
      void contextWindow(state.model ?? "", cur.provider).then((w) => {
        if (!w) return;
        if (state.current?.i === i) state.current.window = w;
        state.peakCtx.set(i, Math.max(state.peakCtx.get(i) ?? 0, used / w));
        tui.requestRender();
      });
    }
    const what =
      m.toolCalls > 0
        ? `${m.toolCalls} tool call${m.toolCalls > 1 ? "s" : ""}`
        : c.yellow(
            `no tool call${
              m.finishReason !== "length"
                ? ""
                : (m.reasoningTokens ?? 0) >= m.outputTokens / 2
                  ? ` (cut off while reasoning: ${kTok(m.reasoningTokens ?? 0)} of ${kTok(m.outputTokens)})`
                  : " (cut off at the token limit)"
            }`,
          );
    const tok = m.inputTokens ? `in ${kTok(m.inputTokens)} · out ${kTok(m.outputTokens)}` : `${m.outputTokens} tok`;
    cur.lines.push(`${c.cyan(`t${m.t}`)}  ${what}  ${c.dim(tok)}${m.text ? c.dim(`  “${m.text}”`) : ""}`);
  } else if (m.type === "tool") {
    const ok = !m.result.startsWith("error");
    cur.lines.push(`${c.dim(`t${m.t}.${m.n}`)} ${c.bold(m.name.padEnd(14))} ${ok ? m.result : c.red(m.result)}`);
  } else if (m.type === "finish.refused") {
    cur.lines.push(`${c.cyan(`t${m.t}`)}  ${c.magenta("finish refused: nothing edited yet")}`);
  }
}

function onLoop(m: LoopMessage) {
  switch (m.type) {
    case "goal.started":
      state.running = true;
      state.model = m.model;
      state.maxAttempts = m.maxAttempts;
      state.maxStalls = m.maxStalls;
      state.rows.clear();
      state.finished = undefined;
      state.waiting = false;
      break;
    case "attempt.scored":
      state.rows.set(m.i, m);
      if (state.current?.i === m.i) state.current = undefined;
      break;
    case "review.waiting":
      state.bestReport = m.report;
      showReview();
      break;
    case "review.resumed":
      if (m.note) state.lastNote = m.note;
      hideReview();
      break;
    case "goal.finished":
      state.running = false;
      state.finished = m;
      state.current = undefined;
      hideReview();
      break;
  }
}

// --- rendering ---
const BLOCKS = " ▁▂▃▄▅▆▇█";

// Full screen by default: the alternate screen buffer (like htop or less), so
// the dashboard fills the window and quitting gives the scrollback back.
// --inline renders in place in the normal buffer instead.
const fullScreen = !argv.includes("--inline");

class Dashboard implements Component {
  invalidate() {}
  render(width: number): string[] {
    const fit = (s: string) => truncateToWidth(s, width);
    // Rows this component may use: the window, less the review editor below it.
    const height = fullScreen ? Math.max(10, terminal.rows - (editorShown ? editor.render(width).length : 0)) : Infinity;
    const chartRows = fullScreen ? Math.max(6, Math.min(12, Math.floor(height / 6))) : 6;
    const rows = sorted();
    const last = lastRow();
    const out: string[] = [];

    const best = last ? `best ${c.bold(fmtScore(last.bestScore))}` : "best –";
    const nextI = (last?.i ?? 0) + (state.finished ? 0 : 1);
    out.push(
      fit(
        `${c.bold("goal-loop")} ${c.cyan(goalId!)}  ${(isDevTarget ? c.yellow : c.magenta)(targetLabel)}  ${c.dim(state.model ?? "")}  ` +
          `attempt ${nextI}/${state.maxAttempts}  stalls ${last?.stalls ?? 0}/${state.maxStalls}  ${best}  ` +
          `$${totalCost().toFixed(3)}  ${c.dim(state.conn)}`,
      ),
    );
    out.push("");

    // Pass rate per attempt (taller is better), one column per attempt. The
    // axis spans the kept attempts' range so small gains stay visible; an
    // attempt below it (a broken edit) shows as a dot on the floor.
    const cols = rows.slice(-Math.max(1, width - 9));
    const pass = (r: ScoredMessage) => 1 - r.score;
    const ref = cols.filter((r) => r.outcome === "kept").map(pass);
    const all = cols.map(pass);
    const lo = ref.length ? Math.max(0, Math.floor((Math.min(...ref) - 0.05) * 20) / 20) : 0;
    const hi = all.length ? Math.min(1, Math.max(lo + 0.05, Math.ceil((Math.max(...all) + 0.01) * 20) / 20)) : 1;
    const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);
    for (let r = chartRows - 1; r >= 0; r--) {
      let line = c.dim(r === chartRows - 1 ? `${pct(hi)} ┤ ` : r === 0 ? `${pct(lo)} ┤ ` : "     │ ");
      for (const row of cols) {
        const v = pass(row);
        const eighths = Math.round(((v - lo) / (hi - lo)) * chartRows * 8) - r * 8;
        const ch = v < lo ? (r === 0 ? "·" : " ") : BLOCKS[Math.max(0, Math.min(8, eighths))]!;
        line += outcomeColour[row.outcome](ch);
      }
      out.push(fit(line));
    }
    out.push(fit(c.dim("       pass rate per attempt · ") + `${c.green("kept")} ${c.yellow("reverted")} ${c.dim("unchanged")} ${c.red("failed")}`));
    out.push("");

    // Last attempts, newest at the bottom (fewer while the review pane is up).
    for (const row of rows.slice(state.waiting ? -4 : -8)) {
      // Δ in failing cases against the best before this attempt.
      const prevBest = rows.find((x) => x.i === row.i - 1)?.bestScore ?? 1;
      const delta = row.failed - Math.round(prevBest * row.total);
      out.push(
        fit(
          `  ${c.dim(`#${String(row.i).padStart(2)}`)} ${outcomeColour[row.outcome](row.outcome.padEnd(9))} ` +
            `${String(row.failed).padStart(6)}/${row.total} failing  ${fmtScore(row.score)}  ` +
            `${row.changed ? (delta < 0 ? c.green : c.yellow)(((delta >= 0 ? "+" : "") + delta).padStart(7)) : "       "}  ` +
            c.dim(
              `turns ${row.turns} idle ${row.idleTurns}  $${row.costUsd.toFixed(4)}` +
                (state.peakCtx.has(row.i) ? `  ctx ${Math.round(state.peakCtx.get(row.i)! * 100)}%` : ""),
            ),
        ),
      );
    }
    out.push("");

    // Flash and key hints sit at the bottom; the pane in between gets the rest.
    const bottom: string[] = [];
    if (state.flash) bottom.push(fit(state.flash));
    if (!state.waiting) {
      const startHint = state.running || state.starting ? "" : `s start ${startSummary()}  ·  `;
      bottom.push(fit(c.dim(`${startHint}q quit`)));
    }
    const room = Math.max(2, height - out.length - bottom.length);

    if (state.finished) {
      const f = state.finished;
      out.push(
        fit(
          `${c.bold("finished")} after ${f.attempts} attempts · best ${fmtScore(f.best.score)} (${f.best.failed}/${f.best.total}) · ` +
            `holdout ${fmtScore(f.holdout.score)} ${f.holdout.pass ? c.green("pass") : c.yellow("not passing")} · $${f.costUsd.toFixed(3)}`,
        ),
      );
    } else if (state.waiting) {
      out.push(...reviewPane(width, rows));
    } else if (state.current) {
      const cur = state.current;
      const ctx = cur.ctx === undefined ? "" : `  context ${cur.window ? meter(cur.ctx, cur.window) : `${kTok(cur.ctx)} tok`}`;
      out.push(fit(`${c.bold(`attempt ${cur.i}`)} ${c.dim(`running ${ago(cur.since)}${cur.provider ? ` · ${cur.provider}` : ""}`)}${ctx}`));
      for (const l of cur.lines.slice(-(fullScreen ? room - 1 : 10))) out.push(fit(`  ${l}`));
    } else if (state.running) {
      out.push(fit(c.dim(state.rows.size ? "waiting for the next attempt…" : "starting: scoring the baseline…")));
    } else if (!state.finished) {
      out.push(fit(c.dim("no run of this goal yet")));
    }
    if (!fullScreen) return [...out, ...bottom];
    // Pad (or, in a short window, clip the pane) so the hints land on the last row.
    const body = out.slice(0, height - bottom.length);
    while (body.length < height - bottom.length) body.push("");
    return [...body, ...bottom];
  }
}

// The local backend shares one workspace on this machine, so a new goal starts
// from fresh stubs. A Cloud worker (sandbox backend) seeds from step state.
const resetsWorkspace = isDevTarget && backend() === "local";

function startSummary() {
  const g = goalArgs;
  return [
    `model ${g.model ?? "(worker default)"}`,
    `${g.maxAttempts ?? GOAL_DEFAULTS.maxAttempts} attempts`,
    `${g.maxStalls ?? GOAL_DEFAULTS.maxStalls} stalls`,
    `${g.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn} tok/turn`,
    g.reasoningMaxTokens ? `reasoning ${g.reasoningMaxTokens} tok` : g.reasoningEffort ? `reasoning ${g.reasoningEffort}` : "reasoning: worker env",
    g.focus === false ? "no focus" : "",
    resetsWorkspace ? "resets workspace" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

async function start() {
  if (state.running || state.starting) return;
  state.starting = true;
  state.flash = c.dim("starting…");
  tui.requestRender();
  try {
    if (resetsWorkspace) await resetWorkspace();
    await startGoal({ ...goalArgs, goalId: goalId! });
    // The worker's goal.started arrives after the baseline is scored; clear now.
    state.rows.clear();
    state.current = undefined;
    state.finished = undefined;
    state.running = true;
    state.maxAttempts = goalArgs.maxAttempts ?? GOAL_DEFAULTS.maxAttempts;
    state.maxStalls = goalArgs.maxStalls ?? GOAL_DEFAULTS.maxStalls;
    state.model = goalArgs.model ?? state.model;
    state.flash = c.green("sent goal/started");
  } catch (err) {
    state.flash = c.red(`start failed: ${(err as Error).message}`);
  }
  state.starting = false;
  tui.requestRender();
}

// What the reviewer needs to write a note: what still fails (the best
// attempt's check report, as the agents see it) and what the stalled
// attempts say they tried.
function reviewPane(width: number, rows: ScoredMessage[]): string[] {
  const out: string[] = [];
  const last = rows.at(-1);
  const bestRow = [...rows].reverse().find((r) => r.outcome === "kept");
  const wrap = (s: string, indent: string) => wrapTextWithAnsi(s, Math.max(20, width - indent.length)).map((l) => indent + l);
  out.push(
    truncateToWidth(
      c.magenta(`⏸  paused for review: ${last?.stalls ?? state.maxStalls} attempts in a row didn't beat the best`) +
        (bestRow ? c.dim(` (#${bestRow.i}, ${bestRow.failed}/${bestRow.total} failing)`) : ""),
      width,
    ),
  );

  out.push(c.bold("What still fails") + c.dim(" (the best attempt's check report, which every attempt also sees):"));
  const report = state.bestReport.split("\n").filter((l) => l.trim());
  if (!report.length) out.push(c.dim("  (no report yet)"));
  const byFn = report.find((l) => l.startsWith("Failures by function:"));
  if (byFn) out.push(...wrap(byFn.replace("Failures by function:", c.yellow("by function:")), "  "));
  const examples = report.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  for (const l of examples.slice(0, 8)) out.push(truncateToWidth(`  ${c.dim("·")} ${l}`, width));
  if (examples.length > 8) out.push(c.dim(`  … ${examples.length - 8} more examples in the report`));

  const stalled = rows.slice(-(last?.stalls || state.maxStalls));
  out.push(c.bold("What the stalled attempts tried:"));
  for (const r of stalled) {
    out.push(
      truncateToWidth(`  ${c.dim(`#${r.i}`)} ${outcomeColour[r.outcome](r.outcome.padEnd(9))} ${r.summary ? `“${r.summary}”` : c.dim("(no summary)")}`, width),
    );
  }
  out.push(c.dim("Write a rule the model keeps missing, not a single case (it would overfit). The note goes into every"));
  out.push(c.dim("attempt's brief and replaces the previous one.  Enter = continue · Alt+Enter = new line · Ctrl+S = stop"));
  return out.map((l) => truncateToWidth(l, width));
}

// --- TUI wiring ---
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const dashboard = new Dashboard();
const identity = (s: string) => s;
const editor = new Editor(tui, {
  borderColor: c.magenta,
  selectList: { selectedPrefix: identity, selectedText: identity, description: c.dim, scrollInfo: c.dim, noMatch: c.dim },
});
tui.addChild(dashboard);

let editorShown = false;
function showReview() {
  state.waiting = true;
  if (editorShown) return;
  editorShown = true;
  editor.setText(state.lastNote);
  tui.addChild(editor);
  tui.setFocus(editor);
}
function hideReview() {
  state.waiting = false;
  if (!editorShown) return;
  editorShown = false;
  tui.removeChild(editor);
  tui.setFocus(null);
}

async function sendReview(action: "continue" | "stop", note?: string) {
  try {
    await inngest.send(goalReviewSubmitted.create({ goalId: goalId!, action, ...(note ? { note } : {}) }));
    if (note) state.lastNote = note;
    state.flash = c.green(action === "stop" ? "sent: stop" : `sent note (${note?.length ?? 0} chars)`);
    hideReview();
  } catch (err) {
    state.flash = c.red(`send failed: ${(err as Error).message}`);
  }
  tui.requestRender();
}
editor.onSubmit = (text) => void sendReview("continue", text.trim() || undefined);

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
// Leave the alternate screen however the process ends (quit, crash, signal).
if (fullScreen) process.on("exit", () => process.stdout.write(ALT_SCREEN_OFF));

const quit = () => {
  sub?.close("quit");
  tui.stop();
  process.exit(0);
};
tui.addInputListener((data) => {
  if (matchesKey(data, "ctrl+c")) quit();
  if (editorShown && matchesKey(data, "ctrl+s")) {
    void sendReview("stop");
    return { consume: true };
  }
  if (!editorShown && data === "q") quit();
  if (!editorShown && data === "s") void start();
  return undefined;
});

if (fullScreen) process.stdout.write(ALT_SCREEN_ON);
tui.start();
const ticker = setInterval(() => tui.requestRender(), 1000);
ticker.unref();

// History first, then live. Live messages that overlap the history are
// deduplicated by attempt number (rows) and step (attempt lines).
let sub: { close(reason?: string): void } | undefined;
try {
  const h = await loadGoalHistory(goalId);
  state.model = h.model ?? state.model;
  state.maxAttempts = h.maxAttempts ?? state.maxAttempts;
  state.maxStalls = h.maxStalls ?? state.maxStalls;
  for (const r of h.rows) state.rows.set(r.i, r);
  state.lastNote = h.lastNote ?? "";
  state.bestReport = h.bestReport ?? "";
  if (h.finished) state.finished = { type: "goal.finished", ...h.finished };
  state.running = h.startedAt !== undefined && !h.finished;
  if (h.waiting) showReview();
  state.conn = "connecting…";
} catch (err) {
  state.conn = c.red(`history failed: ${(err as Error).message}`);
}
tui.requestRender();

async function connect() {
  try {
    sub = await subscribe({
      app: inngest,
      channel: goalChannel(goalId!),
      topics: ["loop", "attempt"],
      onMessage: (msg: { kind: string; topic?: string; data: unknown }) => {
        if (msg.kind !== "data") return;
        if (msg.topic === "loop") onLoop(msg.data as LoopMessage);
        else onAttempt(msg.data as AttemptMessage);
        tui.requestRender();
      },
      onError: (err: unknown) => {
        state.conn = c.red(`live: ${(err as Error)?.message ?? err}; reconnecting`);
        tui.requestRender();
        setTimeout(connect, 5000);
      },
    });
    state.conn = c.green("● live");
  } catch (err) {
    state.conn = c.red(`live: ${(err as Error).message}; retrying`);
    setTimeout(connect, 5000);
  }
  tui.requestRender();
}
// Subscribe before starting, so the run's first messages aren't missed.
await connect();
if (argv.includes("--start")) await start();
