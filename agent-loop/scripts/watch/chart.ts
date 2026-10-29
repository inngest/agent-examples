// The pass-rate chart: one column per attempt, taller is better, coloured by
// outcome. Each cell is a block in eighths, so a column is `height` × 8 steps.
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ScoredMessage } from "../../src/inngest/channel.js";
import { c, outcomeColour, pct } from "./format.js";

const BLOCKS = " ▁▂▃▄▅▆▇█";

const passRate = (r: ScoredMessage) => 1 - r.score;

// The axis spans the kept attempts' range (5% steps) so small gains stay
// visible; an attempt below it (a broken edit) shows as a dot on the floor.
function axisRange(cols: ScoredMessage[]) {
  const kept = cols.filter((r) => r.outcome === "kept").map(passRate);
  const all = cols.map(passRate);
  const lo = kept.length ? Math.max(0, Math.floor((Math.min(...kept) - 0.05) * 20) / 20) : 0;
  const hi = all.length ? Math.min(1, Math.max(lo + 0.05, Math.ceil((Math.max(...all) + 0.01) * 20) / 20)) : 1;
  return { lo, hi };
}

// `height` chart rows plus the legend line, top row first.
export function passRateChart(rows: ScoredMessage[], width: number, height: number): string[] {
  const cols = rows.slice(-Math.max(1, width - 9)); // the newest that fit beside the axis
  const { lo, hi } = axisRange(cols);
  const out: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    let line = c.dim(r === height - 1 ? `${pct(hi)} ┤ ` : r === 0 ? `${pct(lo)} ┤ ` : "     │ ");
    for (const row of cols) {
      const v = passRate(row);
      const eighths = Math.round(((v - lo) / (hi - lo)) * height * 8) - r * 8;
      const ch = v < lo ? (r === 0 ? "·" : " ") : BLOCKS[Math.max(0, Math.min(8, eighths))]!;
      line += outcomeColour[row.outcome](ch);
    }
    out.push(truncateToWidth(line, width));
  }
  out.push(truncateToWidth(c.dim("       pass rate per attempt · ") + `${c.green("kept")} ${c.yellow("reverted")} ${c.dim("unchanged")} ${c.red("failed")}`, width));
  return out;
}
