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
// Failing-case lines kept on the result for the loop to rotate through, one
// window of MAX_EXAMPLES per attempt, so a stalled goal doesn't show every
// attempt the same ten cases.
const EXAMPLE_POOL = 60;
const MAX_REGRESSIONS = 5;
// Per failing function, for a brief that shows many of the focus function's cases.
const EXAMPLES_PER_FN = 50;

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

const byArgsLength = (a: Case, b: Case) => JSON.stringify(a.args).length - JSON.stringify(b.args).length;

/** Failing cases, round-robin across the worst functions, shortest args first within each. */
function pickExamples(cases: Case[], rows: Map<string, Row>, byFn: ScoreResult["byFn"], max: number): Case[] {
  const worst = Object.entries(byFn)
    .filter(([, v]) => v.failed > 0)
    .sort((a, b) => b[1].failed - a[1].failed || a[0].localeCompare(b[0]));
  const perFn = new Map<string, Case[]>();
  for (const c of cases) {
    if (rows.get(c.id)?.ok) continue;
    if (!perFn.has(c.fn)) perFn.set(c.fn, []);
    perFn.get(c.fn)!.push(c);
  }
  for (const list of perFn.values()) list.sort(byArgsLength);

  const picked: Case[] = [];
  for (let round = 0; picked.length < max; round++) {
    let any = false;
    for (const [fn] of worst) {
      const c = perFn.get(fn)?.[round];
      if (c && picked.length < max) {
        picked.push(c);
        any = true;
      }
    }
    if (!any) break;
  }
  return picked;
}

/** Each failing function's failing cases, shortest args first, up to EXAMPLES_PER_FN. */
function examplesByFn(cases: Case[], rows: Map<string, Row>): Record<string, string[]> {
  const out: Record<string, Case[]> = {};
  for (const c of cases) if (!rows.get(c.id)?.ok) (out[c.fn] ??= []).push(c);
  return Object.fromEntries(
    Object.entries(out).map(([fn, list]) => [fn, list.sort(byArgsLength).slice(0, EXAMPLES_PER_FN).map((c) => exampleLine(c, rows))]),
  );
}

/** `Fn(args) expected X, got Y` (or threw / no result), without the leading "- ". */
function exampleLine(c: Case, rows: Map<string, Row>): string {
  const r = rows.get(c.id);
  const args = c.args.map((a) => showValue(a)).join(", ");
  const outcome = r
    ? r.error !== undefined
      ? `threw: ${sanitizeError(r.error)}`
      : `got ${showValue(r.actual)}`
    : "no result (run did not finish)";
  return `${c.fn}(${args}) expected ${showValue(c.expected)}, ${outcome}`;
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

  const picked = pickExamples(cases, rows, byFn, MAX_EXAMPLES);
  if (picked.length) lines.push("Example failures:");
  for (const c of picked) lines.push(`- ${exampleLine(c, rows)}`);
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
  byFn: Record<string, { total: number; failed: number }>;
};

// One bit per case in file order (set = failing), base64: ~3KB for 17,752 cases.
export function encodeFailBits(failing: boolean[]): string {
  const bytes = new Uint8Array(Math.ceil(failing.length / 8));
  failing.forEach((f, i) => {
    if (f) bytes[i >> 3]! |= 1 << (i & 7);
  });
  return Buffer.from(bytes).toString("base64");
}

export function decodeFailBits(b64: string, n: number): boolean[] {
  const bytes = Buffer.from(b64, "base64");
  return Array.from({ length: n }, (_, i) => ((bytes[i >> 3] ?? 0) & (1 << (i & 7))) !== 0);
}

/** Parse the runner's JSONL stdout and turn it into a ScoreResult. */
export function scoreFromRunnerOutput(opts: {
  set: CaseSet;
  stdout: string;
  timedOut: boolean;
  timeoutMs: number;
  // failBits of the result to compare against (the current best): cases that
  // pass there and fail here come back as `regressions`.
  against?: string;
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
  const base = {
    checkVersion,
    set: opts.set,
    total,
    failed,
    score: total === 0 ? 1 : failed / total,
    pass: failed === 0,
    byFn,
  };
  if (opts.set !== "train") return { ...base, report: "" };

  const failing = cases.map((c) => !rows.get(c.id)?.ok);
  let regressions: ScoreResult["regressions"];
  if (opts.against) {
    const before = decodeFailBits(opts.against, cases.length);
    const broke = cases.filter((_, i) => failing[i] && !before[i]).sort(byArgsLength);
    regressions = { count: broke.length, examples: broke.slice(0, MAX_REGRESSIONS).map((c) => exampleLine(c, rows)) };
  }
  return {
    ...base,
    report: buildReport(cases, rows, byFn, failed, note),
    failBits: encodeFailBits(failing),
    examples: pickExamples(cases, rows, byFn, EXAMPLE_POOL).map((c) => exampleLine(c, rows)),
    examplesByFn: examplesByFn(cases, rows),
    ...(regressions ? { regressions } : {}),
  };
}
