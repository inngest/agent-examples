// The dashboard, top to bottom: header, pass-rate chart, recent attempts,
// then one pane (finished, review, live attempt, or idle), then the flash
// line and key hints. A pure function of the state and the window size.
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ScoredMessage } from "../../src/inngest/channel.js";
import { isDevTarget, targetLabel } from "../watch-target.js";
import { passRateChart } from "./chart.js";
import { ago, c, fmtScore, kTok, meter, outcomeColour } from "./format.js";
import { reviewPane } from "./review.js";
import { sortedRows, type CurrentAttempt, type Step, type WatchState } from "./state.js";

export type View = {
  goalId: string;
  width: number;
  // Rows the dashboard may fill; undefined when rendering inline (no limit).
  height?: number;
  // What `s` would start, for the key hint.
  startSummary: string;
};

export function renderDashboard(s: WatchState, v: View): string[] {
  const { width, height } = v;
  const fit = (line: string) => truncateToWidth(line, width);
  const rows = sortedRows(s);
  const out: string[] = [];

  out.push(fit(header(s, rows, v.goalId)), "");
  out.push(...passRateChart(rows, width, height === undefined ? 6 : Math.max(6, Math.min(12, Math.floor(height / 6)))), "");
  // Fewer rows while the review pane is up.
  for (const row of rows.slice(s.waiting ? -4 : -8)) out.push(fit(attemptRow(s, rows, row)));
  out.push("");

  // Flash and key hints sit at the bottom; the pane in between gets the rest.
  const bottom: string[] = [];
  if (s.flash) bottom.push(fit(s.flash));
  if (!s.waiting) {
    const startHint = s.running || s.starting ? "" : `s start ${v.startSummary}  ·  `;
    bottom.push(fit(c.dim(`${startHint}q quit`)));
  }

  if (s.finished) {
    const f = s.finished;
    out.push(
      fit(
        `${c.bold("finished")} after ${f.attempts} attempts · best ${fmtScore(f.best.score)} (${f.best.failed}/${f.best.total}) · ` +
          `holdout ${fmtScore(f.holdout.score)} ${f.holdout.pass ? c.green("pass") : c.yellow("not passing")} · $${f.costUsd.toFixed(3)}`,
      ),
    );
  } else if (s.waiting) {
    out.push(...reviewPane(s, rows, width));
  } else if (s.current) {
    // Inline, show the last 10 steps; full screen, as many as fit.
    const maxSteps = height === undefined ? 10 : Math.max(2, height - out.length - bottom.length) - 1;
    out.push(...livePane(s.current, maxSteps).map(fit));
  } else if (s.running) {
    out.push(fit(c.dim(s.rows.size ? "waiting for the next attempt…" : "starting: scoring the baseline…")));
  } else {
    out.push(fit(c.dim("no run of this goal yet")));
  }

  if (height === undefined) return [...out, ...bottom];
  // Pad (or, in a short window, clip the pane) so the hints land on the last row.
  const body = out.slice(0, height - bottom.length);
  while (body.length < height - bottom.length) body.push("");
  return [...body, ...bottom];
}

function header(s: WatchState, rows: ScoredMessage[], goalId: string) {
  const last = rows.at(-1);
  const best = last ? `best ${c.bold(fmtScore(last.bestScore))}` : "best –";
  const nextI = (last?.i ?? 0) + (s.finished ? 0 : 1);
  const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  return (
    `${c.bold("goal-loop")} ${c.cyan(goalId)}  ${(isDevTarget ? c.yellow : c.magenta)(targetLabel)}  ${c.dim(s.model ?? "")}  ` +
    `attempt ${nextI}/${s.maxAttempts}  stalls ${last?.stalls ?? 0}/${s.maxStalls}  ${best}  ` +
    `$${cost.toFixed(3)}  ${c.dim(s.conn)}`
  );
}

// One line of the attempts table. Δ is the change in failing cases against
// the best before this attempt.
function attemptRow(s: WatchState, rows: ScoredMessage[], row: ScoredMessage) {
  const prevBest = rows.find((x) => x.i === row.i - 1)?.bestScore ?? 1;
  const delta = row.failed - Math.round(prevBest * row.total);
  const deltaCell = row.changed ? (delta < 0 ? c.green : c.yellow)(((delta >= 0 ? "+" : "") + delta).padStart(7)) : "       ";
  const peak = s.peakCtx.get(row.i);
  return (
    `  ${c.dim(`#${String(row.i).padStart(2)}`)} ${outcomeColour[row.outcome](row.outcome.padEnd(9))} ` +
    `${String(row.failed).padStart(6)}/${row.total} failing  ${fmtScore(row.score)}  ${deltaCell}  ` +
    c.dim(`turns ${row.turns} idle ${row.idleTurns}  $${row.costUsd.toFixed(4)}` + (peak !== undefined ? `  ctx ${Math.round(peak * 100)}%` : ""))
  );
}

// The running attempt: a status line (elapsed, provider, context meter), then
// its latest steps.
function livePane(cur: CurrentAttempt, maxSteps: number): string[] {
  const ctx = cur.ctx === undefined ? "" : `  context ${cur.window ? meter(cur.ctx, cur.window) : `${kTok(cur.ctx)} tok`}`;
  const status = `${c.bold(`attempt ${cur.i}`)} ${c.dim(`running ${ago(cur.since)}${cur.provider ? ` · ${cur.provider}` : ""}`)}${ctx}`;
  return [status, ...cur.steps.slice(-maxSteps).map((m) => `  ${stepLine(m, cur.budget0)}`)];
}

function stepLine(m: Step, budget0: number | undefined): string {
  switch (m.type) {
    case "turn": {
      const tok = m.inputTokens ? `in ${kTok(m.inputTokens)} · out ${kTok(m.outputTokens)}` : `${m.outputTokens} tok`;
      // The reasoning ladder at work (see agent-attempt): a raised budget, reasoning off.
      const ladder = [m.maxTokens && budget0 && m.maxTokens > budget0 ? `budget ${kTok(m.maxTokens)}` : "", m.reasoningOff ? "reasoning off" : ""].filter(Boolean);
      return (
        `${c.cyan(`t${m.t}`)}  ${turnSummary(m)}  ${c.dim(tok)}` +
        (ladder.length ? `  ${c.magenta(ladder.join(" · "))}` : "") +
        (m.text ? c.dim(`  “${m.text}”`) : "")
      );
    }
    case "tool": {
      const ok = !m.result.startsWith("error");
      return `${c.dim(`t${m.t}.${m.n}`)} ${c.bold(m.name.padEnd(14))} ${ok ? m.result : c.red(m.result)}`;
    }
    case "finish.refused":
      return `${c.cyan(`t${m.t}`)}  ${c.magenta("finish refused: nothing edited yet")}`;
  }
}

// "2 tool calls", or why the turn made none (a cut-off is usually reasoning
// that ran out of budget).
function turnSummary(m: Extract<Step, { type: "turn" }>) {
  if (m.toolCalls > 0) return `${m.toolCalls} tool call${m.toolCalls > 1 ? "s" : ""}`;
  const reasoning = m.reasoningTokens ?? 0;
  const why =
    m.finishReason !== "length"
      ? ""
      : m.blank
        ? ` (cut off: ${kTok(m.outputTokens)} of whitespace)`
        : reasoning >= m.outputTokens / 2
        ? ` (cut off while reasoning: ${kTok(reasoning)} of ${kTok(m.outputTokens)})`
        : " (cut off at the token limit)";
  return c.yellow(`no tool call${why}`);
}
