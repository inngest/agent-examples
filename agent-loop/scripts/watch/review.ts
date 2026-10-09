// The review pane, shown while the loop is paused for review: what the
// reviewer needs to write a note. That is what still fails (the best
// attempt's check report, as the agents see it) and what the stalled attempts
// say they tried. The editor itself sits below this, in watch-goal.ts.
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ScoredMessage } from "../../src/inngest/channel.js";
import { c, outcomeColour } from "./format.js";
import type { WatchState } from "./state.js";

const MAX_EXAMPLES = 8;

export function reviewPane(s: WatchState, rows: ScoredMessage[], width: number): string[] {
  const out: string[] = [];
  const last = rows.at(-1);
  const bestRow = [...rows].reverse().find((r) => r.outcome === "kept");
  const wrap = (text: string, indent: string) => wrapTextWithAnsi(text, Math.max(20, width - indent.length)).map((l) => indent + l);

  out.push(
    c.magenta(`⏸  paused for review: ${last?.stalls ?? s.maxStalls} attempts in a row didn't beat the best`) +
      (bestRow ? c.dim(` (#${bestRow.i}, ${bestRow.failed}/${bestRow.total} failing)`) : ""),
  );

  out.push(c.bold("What still fails") + c.dim(" (the best attempt's check report, which every attempt also sees):"));
  const report = s.bestReport.split("\n").filter((l) => l.trim());
  if (!report.length) out.push(c.dim("  (no report yet)"));
  const byFn = report.find((l) => l.startsWith("Failures by function:"));
  if (byFn) out.push(...wrap(byFn.replace("Failures by function:", c.yellow("by function:")), "  "));
  const examples = report.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  for (const l of examples.slice(0, MAX_EXAMPLES)) out.push(`  ${c.dim("·")} ${l}`);
  if (examples.length > MAX_EXAMPLES) out.push(c.dim(`  … ${examples.length - MAX_EXAMPLES} more examples in the report`));

  out.push(c.bold("What the stalled attempts tried:"));
  for (const r of rows.slice(-(last?.stalls || s.maxStalls))) {
    out.push(`  ${c.dim(`#${r.i}`)} ${outcomeColour[r.outcome](r.outcome.padEnd(9))} ${r.summary ? `“${r.summary}”` : c.dim("(no summary)")}`);
  }

  out.push(c.dim("Write a rule the model keeps missing, not a single case (it would overfit). The note goes into every"));
  out.push(c.dim("attempt's brief and replaces the previous one.  Enter = continue · Alt+Enter = new line · Ctrl+S = stop"));
  return out.map((l) => truncateToWidth(l, width));
}
