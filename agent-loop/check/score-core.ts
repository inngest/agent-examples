// Pure scoring logic shared by both grader backends (local child process in
// run-check.ts, fresh Inngest sandbox in run-check-sandbox.ts): case loading,
// checkVersion, runner-output parsing, report building. Part of checkVersion.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHECK_DIR, DATA_DIR } from "../src/lib/paths.js";
import type { CaseSet, CheckResult } from "./types.js";

const REPORT_MAX_CHARS = 2048;
const MAX_EXAMPLES = 10;

export type Case = { id: string; fn: string; args: unknown[]; expected: unknown };
export type Row = { id: string; ok: boolean; actual?: unknown; error?: string };

export const casesPath = (set: CaseSet) => path.join(DATA_DIR, `cases.${set}.jsonl`);

export function loadCases(set: CaseSet): Case[] {
  return fs
    .readFileSync(casesPath(set), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Case);
}

export function computeCheckVersion(): string {
  const files = [
    path.join(CHECK_DIR, "run-check.ts"),
    path.join(CHECK_DIR, "score-core.ts"),
    path.join(CHECK_DIR, "runner.ts"),
    path.join(CHECK_DIR, "types.ts"),
    casesPath("train"),
    casesPath("holdout"),
  ].sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(path.basename(f) + "\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// ---- report ----------------------------------------------------------------

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function showValue(v: unknown, n = 70): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return clip(s, n);
}

/** Keep only the message: no stack frames, no absolute paths (except src/semver.ts). */
export function sanitizeError(raw: string, max = 120): string {
  const msg = raw
    .split("\n")
    .filter((l) => !/^\s*at\s/.test(l))
    .join(" ")
    .replace(/(?:file:\/\/)?(?:\/[\w.@~+-]+){2,}(?::\d+){0,2}/g, (m) =>
      /\/src\/semver\.ts(?::\d+){0,2}$/.test(m) ? "src/semver.ts" : "<path>",
    )
    .replace(/\s+/g, " ")
    .trim();
  return clip(msg, max);
}

export function buildReport(
  cases: Case[],
  rows: Map<string, Row>,
  byFn: ScoreResult["byFn"],
  failed: number,
  note: string | undefined,
): string {
  const total = cases.length;
  const lines: string[] = [];
  const worst = Object.entries(byFn)
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => b[1].failed - a[1].failed || a[0].localeCompare(b[0]));
  lines.push(`Failures by function: ${worst.length ? worst.map(([k, v]) => `${k} ${v.failed}/${v.total}`).join(", ") : "none"}`);
  if (note) lines.push(`Note: ${note}`);

  // failing cases per fn, shortest args first (easiest to read and reason about)
  const perFn = new Map<string, Case[]>();
  for (const c of cases) {
    if (rows.get(c.id)?.ok) continue;
    if (!perFn.has(c.fn)) perFn.set(c.fn, []);
    perFn.get(c.fn)!.push(c);
  }
  for (const list of perFn.values()) list.sort((a, b) => JSON.stringify(a.args).length - JSON.stringify(b.args).length);

  const picked: Case[] = [];
  for (let round = 0; picked.length < MAX_EXAMPLES; round++) {
    let any = false;
    for (const [fn] of worst) {
      const c = perFn.get(fn)?.[round];
      if (c && picked.length < MAX_EXAMPLES) {
        picked.push(c);
        any = true;
      }
    }
    if (!any) break;
  }
  if (picked.length) lines.push("Example failures:");
  for (const c of picked) {
    const r = rows.get(c.id);
    const args = c.args.map((a) => showValue(a)).join(", ");
    const outcome = r
      ? r.error !== undefined
        ? `threw: ${sanitizeError(r.error)}`
        : `got ${showValue(r.actual)}`
      : "no result (run did not finish)";
    lines.push(`- ${c.fn}(${args}) expected ${showValue(c.expected)}, ${outcome}`);
  }
  const totals = `Total: ${failed} of ${total} cases failed.`;
  lines.push(totals);

  let out = lines.join("\n");
  if (out.length > REPORT_MAX_CHARS) {
    // drop example lines from the end until it fits; the totals line always stays
    const head = lines.slice(0, -1);
    while (head.length > 2 && head.join("\n").length + 1 + totals.length > REPORT_MAX_CHARS) head.pop();
    out = clip(head.join("\n"), REPORT_MAX_CHARS - totals.length - 1) + "\n" + totals;
  }
  return out;
}

// ---- runner output -> result -----------------------------------------------

export type ScoreResult = Omit<CheckResult, "commit"> & {
  /** Per-function totals and failure counts (extra field; not part of CheckResult). */
  byFn: Record<string, { total: number; failed: number }>;
};

/** Parse the runner's JSONL stdout and turn it into a ScoreResult. */
export function scoreFromRunnerOutput(opts: {
  set: CaseSet;
  stdout: string;
  timedOut: boolean;
  timeoutMs: number;
}): ScoreResult {
  const checkVersion = computeCheckVersion();
  const cases = loadCases(opts.set);

  const rows = new Map<string, Row>();
  let fatal: string | undefined;
  for (const line of opts.stdout.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.fatal === "string") fatal = o.fatal;
      else if (typeof o.id === "string") rows.set(o.id, o);
    } catch {
      // truncated final line from a killed child
    }
  }

  let note: string | undefined;
  if (fatal) note = sanitizeError(fatal, 200);
  else if (opts.timedOut) note = `run timed out after ${opts.timeoutMs / 1000}s; unfinished cases count as failed`;
  else if (rows.size < cases.length) note = "run ended early (crash or out of memory); unfinished cases count as failed";

  const byFn: ScoreResult["byFn"] = {};
  let failed = 0;
  for (const c of cases) {
    const b = (byFn[c.fn] ??= { total: 0, failed: 0 });
    b.total++;
    if (!rows.get(c.id)?.ok) {
      b.failed++;
      failed++;
    }
  }
  const total = cases.length;
  return {
    checkVersion,
    set: opts.set,
    total,
    failed,
    score: total === 0 ? 1 : failed / total,
    pass: failed === 0,
    report: opts.set === "train" ? buildReport(cases, rows, byFn, failed, note) : "",
    byFn,
  };
}
