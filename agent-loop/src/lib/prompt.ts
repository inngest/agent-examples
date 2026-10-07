export const SYSTEM_PROMPT = `You are a careful TypeScript engineer. You work in a small project through tools: list_files, read_file, edit_file, write_file, typecheck and finish_attempt. All paths are relative to src/ (for example "semver.ts"). Only .ts files can be written. Read the file before changing it. Prefer edit_file for targeted fixes (old_string must match exactly once). Use write_file only to create a file or for a full rewrite; if the file is still stubs, writing the full port once with write_file is fine. Every write or edit is typechecked automatically, so read the errors in the result and fix them. Once the change is made and typechecks, call finish_attempt with a one-line summary right away; don't keep polishing.`;

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

const EXAMPLES_PER_BRIEF = 10;

// A different window of the best result's failing examples for each attempt:
// a stalled goal otherwise shows every attempt the same ten cases.
export function rotateExamples(pool: string[], i: number, n = EXAMPLES_PER_BRIEF): string[] {
  if (pool.length <= n) return pool;
  const start = ((i - 1) * n) % pool.length;
  return Array.from({ length: n }, (_, k) => pool[(start + k) % pool.length]!);
}

function reportWithExamples(report: string, examples: string[] | undefined, i: number): string {
  if (!examples?.length) return report;
  const lines = report.split("\n");
  const head = lines.filter((l) => !l.startsWith("- ") && l !== "Example failures:" && !l.startsWith("Total:"));
  const total = lines.find((l) => l.startsWith("Total:"));
  return [
    ...head,
    "Example failures (a different sample each attempt):",
    ...rotateExamples(examples, i).map((l) => `- ${l}`),
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
}): string {
  const { i, best, humanNote, report, examples, journal, regressions } = opts;
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
  parts.push(`Check report:\n${reportWithExamples(report, examples, i)}`);
  return parts.join("\n\n");
}
