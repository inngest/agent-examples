// Colours and number formatting shared by the watcher's panes.
import type { AttemptOutcome } from "../../src/inngest/channel.js";

// pi-tui resets styles at the end of every line, so each span closes itself.
const sgr = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const c = { dim: sgr("2"), bold: sgr("1"), green: sgr("32"), yellow: sgr("33"), red: sgr("31"), cyan: sgr("36"), magenta: sgr("35") };
export const outcomeColour: Record<AttemptOutcome, (s: string) => string> = { kept: c.green, reverted: c.yellow, unchanged: c.dim, failed: c.red };

// Score is the failing share (lower is better).
export const fmtScore = (s: number) => s.toFixed(3);

// Token counts: 950, 1.2k, 128k.
export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

// Percent, right-aligned to 4 columns ("  5%", "100%").
export const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);

// Time since `ms`: 42s, 3m07s.
export function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// A context-window bar: green, then yellow past half, red past 80%.
export function meter(used: number, window: number, cells = 12) {
  const share = Math.min(1, used / window);
  const filled = Math.round(share * cells);
  const colour = share > 0.8 ? c.red : share > 0.5 ? c.yellow : c.green;
  return `${colour("█".repeat(filled))}${c.dim("░".repeat(cells - filled))} ${kTok(used)} / ${kTok(window)} (${Math.round(share * 100)}%)`;
}
