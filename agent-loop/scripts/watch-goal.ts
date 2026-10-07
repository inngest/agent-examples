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
//
// This file is the wiring: arguments, the TUI and its keys, history then live
// messages, and sending start / review events. The rest is in scripts/watch/:
// state.ts (how messages change the state), render.ts (the dashboard),
// chart.ts, review.ts, format.ts.
import { isDevTarget } from "./watch-target.js"; // must stay first: sets INNGEST_DEV
import { Editor, matchesKey, ProcessTerminal, TUI, type Component } from "@mariozechner/pi-tui";
import { subscribe } from "inngest/realtime";
import { inngest } from "../src/inngest/client.js";
import { GOAL_DEFAULTS, goalReviewSubmitted } from "../src/inngest/events.js";
import { goalChannel, type AttemptMessage, type LoopMessage } from "../src/inngest/channel.js";
import { loadGoalHistory } from "../src/lib/goal-history.js";
import { parseGoalArgs, startGoal } from "../src/lib/start-goal.js";
import { resetWorkspace } from "../src/lib/reset-workspace.js";
import { backend } from "../src/lib/backend.js";
import { c } from "./watch/format.js";
import { applyAttempt, applyHistory, applyLoop, applyStartSent, createState } from "./watch/state.js";
import { renderDashboard } from "./watch/render.js";

const argv = process.argv.slice(2);
const goalArgs = parseGoalArgs(argv);
const goalId = goalArgs.goalId!;
if (!goalId) {
  console.error("usage: pnpm goal:watch -- --goal <id> [--dev | --cloud] [--start] [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N] [--reasoning-effort low|medium|high] [--reasoning-max-tokens N] [--no-focus] [--inline]");
  process.exit(2);
}

// Full screen by default: the alternate screen buffer (like htop or less), so
// the dashboard fills the window and quitting gives the scrollback back.
// --inline renders in place in the normal buffer instead.
const fullScreen = !argv.includes("--inline");

// The local backend shares one workspace on this machine, so a new goal starts
// from fresh stubs. A Cloud worker (sandbox backend) seeds from step state.
const resetsWorkspace = isDevTarget && backend() === "local";

const state = createState(goalArgs);

// What `s` would start, for the key hint.
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

// --- TUI ---
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const identity = (s: string) => s;
const editor = new Editor(tui, {
  borderColor: c.magenta,
  selectList: { selectedPrefix: identity, selectedText: identity, description: c.dim, scrollInfo: c.dim, noMatch: c.dim },
});
let editorShown = false;

class Dashboard implements Component {
  invalidate() {}
  render(width: number): string[] {
    // Full screen, the dashboard gets the window less the review editor below it.
    const height = fullScreen ? Math.max(10, terminal.rows - (editorShown ? editor.render(width).length : 0)) : undefined;
    return renderDashboard(state, { goalId, width, height, startSummary: startSummary() });
  }
}
tui.addChild(new Dashboard());

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

// --- sending events ---
async function start() {
  if (state.running || state.starting) return;
  state.starting = true;
  state.flash = c.dim("starting…");
  tui.requestRender();
  try {
    if (resetsWorkspace) await resetWorkspace();
    await startGoal({ ...goalArgs, goalId });
    applyStartSent(state, goalArgs);
    state.flash = c.green("sent goal/started");
  } catch (err) {
    state.flash = c.red(`start failed: ${(err as Error).message}`);
  }
  state.starting = false;
  tui.requestRender();
}

async function sendReview(action: "continue" | "stop", note?: string) {
  try {
    await inngest.send(goalReviewSubmitted.create({ goalId, action, ...(note ? { note } : {}) }));
    if (note) state.lastNote = note;
    state.flash = c.green(action === "stop" ? "sent: stop" : `sent note (${note?.length ?? 0} chars)`);
    hideReview();
  } catch (err) {
    state.flash = c.red(`send failed: ${(err as Error).message}`);
  }
  tui.requestRender();
}
editor.onSubmit = (text) => void sendReview("continue", text.trim() || undefined);

// --- keys and screen ---
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
// Leave the alternate screen however the process ends (quit, crash, signal).
if (fullScreen) process.on("exit", () => process.stdout.write(ALT_SCREEN_OFF));

let sub: { close(reason?: string): void } | undefined;
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
  // While the editor is up, letters are typing, not commands.
  if (!editorShown && data === "q") quit();
  if (!editorShown && data === "s") void start();
  return undefined;
});

if (fullScreen) process.stdout.write(ALT_SCREEN_ON);
tui.start();
// Re-render every second so elapsed times tick.
setInterval(() => tui.requestRender(), 1000).unref();

// --- history, then live ---
try {
  if (applyHistory(state, await loadGoalHistory(goalId))) showReview();
  state.conn = "connecting…";
} catch (err) {
  state.conn = c.red(`history failed: ${(err as Error).message}`);
}
tui.requestRender();

function onLiveMessage(topic: string | undefined, data: unknown) {
  if (topic === "loop") {
    const review = applyLoop(state, data as LoopMessage);
    if (review === "show-review") showReview();
    if (review === "hide-review") hideReview();
  } else {
    applyAttempt(state, data as AttemptMessage, () => tui.requestRender());
  }
  tui.requestRender();
}

async function connect() {
  try {
    sub = await subscribe({
      app: inngest,
      channel: goalChannel(goalId),
      topics: ["loop", "attempt"],
      onMessage: (msg: { kind: string; topic?: string; data: unknown }) => {
        if (msg.kind === "data") onLiveMessage(msg.topic, msg.data);
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
