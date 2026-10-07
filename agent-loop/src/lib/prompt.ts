export const SYSTEM_PROMPT = `You are a careful TypeScript engineer. You work in a small project through tools: list_files, read_file, edit_file, write_file, typecheck and finish_attempt. All paths are relative to src/ (for example "semver.ts"). Only .ts files can be written. The brief includes the current code, so you can edit straight away; after you change a file, read_file shows the new version. Prefer edit_file for targeted fixes (old_string must match exactly once). Use write_file only to create a file or for a full rewrite; if the file is still stubs, writing the full port once with write_file is fine. Every write or edit is typechecked automatically, so read the errors in the result and fix them. Once the change is made and typechecks, call finish_attempt with a one-line summary right away; don't keep polishing.`;

// One line of attempt history, carried from attempt to attempt by goal-loop.
// Everything in it comes from the train check the agents already see a part
// of (per-function counts) and from the attempts' own summaries.
export type JournalEntry = {
  i: number;
  outcome: "kept" | "reverted" | "unchanged" | "failed";
  failed: number;
  summary: string;
  // Per-function change in failing cases against the best at the time (changed attempts only).
  delta?: Record<string, number>;
};
export type Regressions = { i: number; count: number; examples: string[] };
export type Focus = { fn: string; failed: number; total: number };

// The function one attempt works on: the most-failing one, moving down the
// list with each attempt that doesn't improve the best, so a stalled goal
// tries a different function instead of rewriting everything again. Derived
// from loop state only (the best's per-function counts and the stall count).
export function pickFocus(byFn: Record<string, { total: number; failed: number }> | undefined, stalls: number): Focus | undefined {
  const failing = Object.entries(byFn ?? {})
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => b[1].failed - a[1].failed || a[0].localeCompare(b[0]));
  if (!failing.length) return undefined;
  const [fn, v] = failing[stalls % failing.length]!;
  return { fn, failed: v.failed, total: v.total };
}

// The code the attempt starts from, inlined so the first turn can edit instead
// of spending turns on list_files and read_file (each one a chance to stall).
const MAX_CODE_CHARS = 20_000;

const EXAMPLES_PER_BRIEF = 10;

// A different window of the best result's failing examples for each attempt:
// a stalled goal otherwise shows every attempt the same ten cases.
export function rotateExamples(pool: string[], i: number, n = EXAMPLES_PER_BRIEF): string[] {
  if (pool.length <= n) return pool;
  const start = ((i - 1) * n) % pool.length;
  return Array.from({ length: n }, (_, k) => pool[(start + k) % pool.length]!);
}

// With a focus, a rotating window of the focus function's own examples (the
// pool is round-robin across functions, so it holds several of each), topped
// up with other functions' when it has fewer than a window's worth.
function pickShown(pool: string[], i: number, focus?: Focus): string[] {
  if (!focus) return rotateExamples(pool, i);
  const own = pool.filter((l) => l.startsWith(`${focus.fn}(`));
  if (own.length >= EXAMPLES_PER_BRIEF) return rotateExamples(own, i);
  return [...own, ...pool.filter((l) => !l.startsWith(`${focus.fn}(`))].slice(0, EXAMPLES_PER_BRIEF);
}

function reportWithExamples(report: string, examples: string[] | undefined, i: number, focus?: Focus): string {
  if (!examples?.length) return report;
  const shown = pickShown(examples, i, focus);
  const lines = report.split("\n");
  const head = lines.filter((l) => !l.startsWith("- ") && l !== "Example failures:" && !l.startsWith("Total:"));
  const total = lines.find((l) => l.startsWith("Total:"));
  return [
    ...head,
    "Example failures (a different sample each attempt):",
    ...shown.map((l) => `- ${l}`),
    ...(total ? [total] : []),
  ].join("\n");
}

function journalLine(e: JournalEntry): string {
  const what =
    e.outcome === "kept"
      ? `kept (${e.failed} failing, the new best)`
      : e.outcome === "reverted"
        ? `reverted (${e.failed} failing, worse than the best)`
        : e.outcome === "unchanged"
          ? "changed nothing"
          : "failed before finishing (error)";
  const delta = Object.entries(e.delta ?? {})
    .filter(([, d]) => d !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([fn, d]) => `${fn} ${d > 0 ? `${d} more failing` : `${-d} fewer failing`}`)
    .join(", ");
  return `- #${e.i} ${what}${e.summary ? `: "${e.summary}"` : ""}${delta ? `; ${delta}` : ""}`;
}

export function buildBrief(opts: {
  i: number;
  best: { failed: number; total: number };
  humanNote?: string;
  report: string;
  examples?: string[];
  journal?: JournalEntry[];
  regressions?: Regressions;
  focus?: Focus;
  // Current source files (path relative to src/ → contents).
  code?: Record<string, string>;
}): string {
  const { i, best, humanNote, report, examples, journal, regressions, focus, code } = opts;
  const parts = [
    "You're porting golang.org/x/mod/semver to TypeScript in src/semver.ts. Match the Go behavior exactly, including returning \"\" for invalid input instead of throwing. Make one focused change per attempt, guided by the check report below. You can't see or run the check, and it won't change during your attempt. If you believe the report shows the check is wrong, call finish_attempt and explain why in the summary instead of working around it.",
    `Attempt ${i}. Best score so far: ${best.failed}/${best.total} failing.` + (humanNote ? `\nNote from reviewer: ${humanNote}` : ""),
  ];
  if (journal?.length)
    parts.push(
      "Recent attempts (oldest first). You start from the best code, so reverted changes are gone. Don't repeat an approach that was reverted or changed nothing; try something different:\n" +
        journal.map(journalLine).join("\n"),
    );
  if (regressions?.count)
    parts.push(
      `Attempt #${regressions.i} was reverted because it broke ${regressions.count} cases that the best code passes, for example:\n` +
        regressions.examples.map((l) => `- ${l}`).join("\n") +
        "\nIf you change the same code, keep these passing.",
    );
  if (focus)
    parts.push(
      `Focus for this attempt: ${focus.fn} (${focus.failed} of its ${focus.total} cases failing). Fix ${focus.fn}'s failures only. Change other code only if ${focus.fn}'s failures come from it (for example a shared parser), and keep the other functions' cases passing.`,
    );
  parts.push(`Check report:\n${reportWithExamples(report, examples, i, focus)}`);
  if (code && Object.keys(code).length) {
    let room = MAX_CODE_CHARS;
    const blocks: string[] = [];
    for (const [p, c] of Object.entries(code).sort(([a], [b]) => a.localeCompare(b))) {
      if (c.length > room) {
        blocks.push(`src/${p}: (too long to include; use read_file)`);
        continue;
      }
      room -= c.length;
      blocks.push(`src/${p}:\n\`\`\`ts\n${c}${c.endsWith("\n") ? "" : "\n"}\`\`\``);
    }
    parts.push(`Current code (the best version so far, which this attempt starts from). It's exact, so you can copy old_string for edit_file from it:\n\n${blocks.join("\n\n")}`);
  }
  return parts.join("\n\n");
}
