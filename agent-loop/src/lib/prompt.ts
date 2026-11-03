import { EXAMPLES_PER_BRIEF, MAX_CODE_CHARS } from "../config.js";
import { best, focusMisses, journal, note, regressions, type GoalLog } from "./goal-log.js";

export const SYSTEM_PROMPT =`You are a careful TypeScript engineer. You work in a small project on your own machine through tools: work_run (a shell), work_read, work_edit, work_write and work_finish. All paths are relative to src/ (for example "semver.ts"). The brief includes the current code, so you can edit straight away; after you change a file, work_read shows the new version. Prefer work_edit for targeted fixes (old_string must match exactly once). Use work_write only to create a file or for a full rewrite; if the file is still stubs, writing the full port once with work_write is fine. Every write or edit is typechecked automatically, so read the errors in the result and fix them. Once the change is made and typechecks, call work_finish with a one-line summary right away; don't keep polishing. Every reply is a tool call: never write code, JSON or a tool call as plain text, and never pad a reply with whitespace.`;

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

type ByFn = Record<string, { total: number; failed: number }>;

// Functions that fail every case: still stubs, or broken outright. While any
// remain, the attempt is told to implement them all at once; otherwise the
// model goes one function per attempt (see BUILD_LOG: "Focus, second version").
export function unimplemented(byFn: ByFn | undefined): string[] {
  return Object.entries(byFn ?? {})
    .filter(([, v]) => v.total > 0 && v.failed === v.total)
    .map(([fn]) => fn)
    .sort();
}

// The function one attempt works on, once nothing is a stub. `misses` counts,
// per function, the focused attempts that weren't kept. The least-missed
// failing function goes next, the most-failing first among equals, so focus
// moves on from a function it can't fix instead of going back to it after
// every kept attempt. Derived from loop state only, so replay picks the same one.
export function pickFocus(byFn: ByFn | undefined, misses: Record<string, number>): Focus | undefined {
  if (unimplemented(byFn).length) return undefined;
  const failing = Object.entries(byFn ?? {})
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => (misses[a[0]] ?? 0) - (misses[b[0]] ?? 0) || b[1].failed - a[1].failed || a[0].localeCompare(b[0]));
  if (!failing.length) return undefined;
  const [fn, v] = failing[0]!;
  return { fn, failed: v.failed, total: v.total };
}

// The code the attempt starts from is inlined (up to MAX_CODE_CHARS) so the
// first turn can edit instead of spending turns on reading files (each one a
// chance to stall).

// A different window of the best result's failing examples for each attempt:
// a stalled goal otherwise shows every attempt the same ten cases.
export function rotateExamples(pool: string[], i: number, n = EXAMPLES_PER_BRIEF): string[] {
  if (pool.length <= n) return pool;
  const start = ((i - 1) * n) % pool.length;
  return Array.from({ length: n }, (_, k) => pool[(start + k) % pool.length]!);
}

// With a focus, a rotating window of the focus function's own examples, topped
// up with other functions' when it has fewer than a window's worth. Its own
// come from `focusExamples` (up to 50 of them) when the goal asks for more
// examples, else from the pool (round-robin across functions, so a few each).
function pickShown(pool: string[], i: number, focus: Focus | undefined, n: number, focusExamples?: string[]): string[] {
  if (!focus) return rotateExamples(pool, i, n);
  const own = focusExamples?.length ? focusExamples : pool.filter((l) => l.startsWith(`${focus.fn}(`));
  if (own.length >= n) return rotateExamples(own, i, n);
  return [...own, ...pool.filter((l) => !l.startsWith(`${focus.fn}(`))].slice(0, n);
}

function reportWithExamples(report: string, i: number, o: Pick<BriefInput, "examples" | "focus" | "examplesPerBrief" | "focusExamples">): string {
  if (!o.examples?.length) return report;
  const n = o.examplesPerBrief ?? EXAMPLES_PER_BRIEF;
  const shown = pickShown(o.examples, i, o.focus, n, o.examplesPerBrief ? o.focusExamples : undefined);
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

// Everything the brief is built from: the attempt number, the best result so
// far (and its report and example pool), and the attempt-to-attempt context.
export type BriefInput = {
  i: number;
  best: { failed: number; total: number };
  humanNote?: string;
  report: string;
  examples?: string[];
  journal?: JournalEntry[];
  regressions?: Regressions;
  focus?: Focus;
  // Functions failing every case (see unimplemented).
  stubs?: string[];
  // Current source files (path relative to src/ → contents).
  code?: Record<string, string>;
  // Opt-in per goal (--examples N): examples per brief, drawn from the focus
  // function's own failing cases when there's a focus.
  examplesPerBrief?: number;
  focusExamples?: string[];
  // Opt-in per goal (--spec): Go's documentation for the package (data/spec.txt).
  spec?: string;
};

export function buildBrief(opts: BriefInput): string {
  const { i, best, humanNote, report, journal, regressions, focus, stubs, code, spec } = opts;
  const parts = [
    "You're porting golang.org/x/mod/semver to TypeScript in src/semver.ts. Match the Go behavior exactly, including returning \"\" for invalid input instead of throwing. Make one focused change per attempt, guided by the check report below. You can't see or run the check, and it won't change during your attempt. If you believe the report shows the check is wrong, say why in your work_finish summary instead of working around it.",
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
  if (stubs?.length)
    parts.push(
      `Still unimplemented or failing every case: ${stubs.join(", ")}. Implement all of them in this attempt, not one at a time; writing the whole file once with work_write is fine.`,
    );
  if (focus)
    parts.push(
      `Focus for this attempt: ${focus.fn} (${focus.failed} of its ${focus.total} cases failing). Fix ${focus.fn}'s failures only. Change other code only if ${focus.fn}'s failures come from it (for example a shared parser), and keep the other functions' cases passing.`,
    );
  parts.push(`Check report:\n${reportWithExamples(report, i, opts)}`);
  if (spec)
    parts.push(
      `Go's documentation for the package, the behavior to match (the signatures are Go's; the TypeScript ones are in src/semver.ts, where Sort returns the sorted list):\n\`\`\`\n${spec.trimEnd()}\n\`\`\``,
    );
  if (code && Object.keys(code).length) {
    let room = MAX_CODE_CHARS;
    const blocks: string[] = [];
    for (const [p, c] of Object.entries(code).sort(([a], [b]) => a.localeCompare(b))) {
      if (c.length > room) {
        blocks.push(`src/${p}: (too long to include; use work_read)`);
        continue;
      }
      room -= c.length;
      blocks.push(`src/${p}:\n\`\`\`ts\n${c}${c.endsWith("\n") ? "" : "\n"}\`\`\``);
    }
    parts.push(`Current code (the best version so far, which this attempt starts from). It's exact, so you can copy old_string for work_edit from it:\n\n${blocks.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

/** The function attempt `i` works on, when the goal focuses (see pickFocus). */
export function focusFor(log: GoalLog, enabled: boolean): Focus | undefined {
  if (!enabled) return undefined;
  return pickFocus(best(log).byFn, focusMisses(log));
}

/**
 * Attempt `i`'s brief, read off the goal's log: the best code so far and its
 * report, what the earlier attempts did, the reviewer's note, and the focus.
 */
export function attemptBrief(log: GoalLog, i: number, focus: Focus | undefined, options: { examplesPerBrief?: number; specText?: string }): string {
  const current = best(log);
  return buildBrief({
    i,
    best: { failed: current.failed, total: current.total },
    humanNote: note(log),
    report: current.report,
    examples: current.examples,
    journal: journal(log),
    regressions: regressions(log),
    focus,
    stubs: unimplemented(current.byFn),
    code: current.files,
    spec: options.specText,
    examplesPerBrief: options.examplesPerBrief,
    focusExamples: focus && current.examplesByFn?.[focus.fn],
  });
}
