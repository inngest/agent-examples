// pnpm check:harness: the harness's pure parts: the model's reasoning ladder,
// the loop's per-attempt bookkeeping, and the brief. No model, no Inngest.
import type { Graded } from "./grade.js";
import { ladder, settledRung, type ModelSettings } from "../src/models/openrouter.js";
import { JOURNAL_SIZE } from "../src/config.js";
import { attempted, best, focusMisses, journal, note, regressions, stalls, stopped, totals, type Attempt, type Entry, type GoalLog } from "../src/lib/goal-log.js";
import { buildBrief } from "../src/lib/prompt.js";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- reasoning ladder (the rungs; the climb itself happens in one model call)
const settings = (o: Partial<ModelSettings> = {}): ModelSettings => ({
  slug: "m",
  maxTokensPerTurn: 4000,
  maxTokensCap: 32_000,
  supportsReasoning: true,
  ...o,
});
{
  const rungs = ladder(settings({ reasoningMaxTokens: 3000 }));
  ok(
    eq(
      rungs.map((r) => `${r.maxTokens}:${JSON.stringify(r.reasoning)}`),
      ['4000:{"max_tokens":2000}', '4000:{"max_tokens":2000}', '8000:{"max_tokens":3000}', '8000:{"enabled":false}'],
    ),
    "ladder: nudge only, then double once, then reasoning off; reasoning budget clamped to half",
  );
  ok(eq(ladder(settings({ reasoningEffort: "high" }))[0]!.reasoning, { effort: "high" }), "ladder: effort sent when no reasoning budget is set");
  ok(ladder(settings())[0]!.reasoning === undefined, "ladder: no reasoning field when none is configured");
  ok(eq(ladder(settings({ reasoningEffort: "low", reasoningMaxTokens: 1000 }))[0]!.reasoning, { max_tokens: 1000 }), "ladder: token budget wins over effort");
  const unsupported = ladder(settings({ supportsReasoning: false, reasoningMaxTokens: 1000 }));
  ok(unsupported.every((r) => r.reasoning === undefined) && unsupported.at(-1)!.maxTokens === 8000, "ladder: unsupported: never sends reasoning, only the budget rung");
  const capped = ladder(settings({ maxTokensCap: 4000 }));
  ok(capped.length === 3 && eq(capped.at(-1)!.reasoning, { enabled: false }), "ladder: at the cap, no budget rung before reasoning off");
}
{
  const reply = (rung: number, acted: boolean) => ({
    role: "assistant" as const,
    content: { chat: { role: "assistant", content: null, ...(acted ? { tool_calls: [] } : {}) }, rung },
  });
  ok(settledRung([reply(0, true), reply(2, true)]) === 2, "ladder: the next attempt starts on the highest rung that acted");
  ok(settledRung([reply(0, true), reply(3, false)]) === undefined, "ladder: a rung that never acted isn't kept");
}

// --- the goal's log: what happened, and what the goal reads off it
const check = (failed: number, o: Partial<Graded> = {}): Graded => ({
  commit: `c${failed}`,
  checkVersion: "v1",
  set: "train",
  total: 100,
  failed,
  score: failed / 100,
  pass: failed === 0,
  report: `${failed} failing`,
  byFn: { A: { total: 50, failed: Math.ceil(failed / 2) }, B: { total: 50, failed: Math.floor(failed / 2) } },
  files: { "semver.ts": `code ${failed}` },
  ...o,
});
const attempt = (o: Partial<Attempt> = {}): Attempt => ({
  commit: "abc123",
  files: { "semver.ts": "x" },
  changed: true,
  summary: "did a thing",
  finished: true,
  turns: 3,
  noToolCallTurns: 0,
  usage: { input: 10, output: 5, usd: 0.01 },
  ...o,
});
const baseline = check(40);
const start: GoalLog = [{ kind: "baseline", result: baseline }];
const review = (i: number, o: { note?: string; stop?: boolean; resumed?: boolean } = {}): Entry => ({ kind: "review", i, stop: false, resumed: false, ...o });
{
  const kept = attempted(2, attempt(), check(30), baseline);
  ok(kept.outcome === "kept" && kept.deltaFailed === -10, "log: a better score is kept");
  ok(eq(kept.delta, { A: -5, B: -5 }), "log: the per-function delta is recorded");
  const reverted = attempted(2, attempt(), check(50, { regressions: { count: 3, examples: ["A(x)"] } }), baseline);
  ok(reverted.outcome === "reverted", "log: a worse score is reverted");
  ok(attempted(2, attempt({ changed: false }), baseline, baseline).outcome === "unchanged", "log: no change is unchanged");
  ok(attempted(2, null, baseline, baseline).outcome === "failed", "log: a failed attempt (null) is failed");

  ok(best([...start, reverted]).failed === 40 && best([...start, kept]).failed === 30, "best: the baseline until an attempt is kept");
  ok(best([...start, { kind: "rescored", i: 3, result: check(45, { checkVersion: "v2" }) }]).checkVersion === "v2", "best: a re-score under a new grader replaces it");

  ok(eq(regressions([...start, reverted]), { i: 2, count: 3, examples: ["A(x)"] }), "regressions: from the last reverted attempt");
  ok(regressions([...start, reverted, kept]) === undefined, "regressions: cleared once one is kept");

  const unchanged = (i: number) => attempted(i, attempt({ changed: false }), baseline, baseline);
  const seven: GoalLog = [...start, ...[1, 2, 3, 4, 5, 6, 7].map(unchanged)];
  const j = journal(seven);
  ok(j.length === JOURNAL_SIZE && j[0]?.i === 3 && j[4]?.i === 7, "journal: the last 5");

  ok(stalls(seven) === 7, "stalls: attempts since the start");
  ok(stalls([...start, unchanged(1), { ...kept, i: 2 }, unchanged(3)]) === 1, "stalls: since the last kept attempt");
  ok(stalls([...start, unchanged(1), review(1, { resumed: true }), unchanged(2)]) === 1, "stalls: since the review that ended a wait");
  ok(stalls([...start, unchanged(1), review(1), unchanged(2)]) === 2, "stalls: a note sent mid-goal doesn't reset them");

  ok(note([...start, review(1, { note: "a" }), review(2), review(3, { note: "b" })]) === "b", "reviews: the latest note wins");
  ok(stopped([...start, review(1, { stop: true })]) && !stopped([...start, review(1, { note: "a" })]), "reviews: a stop ends the goal");

  const focus = { fn: "A", failed: 20, total: 50 };
  const misses = focusMisses([...start, attempted(1, attempt(), check(50), baseline, focus), attempted(2, attempt(), check(30), baseline, focus), unchanged(3)]);
  ok(misses.A === 1, "focus: a focused attempt that wasn't kept is a miss; a kept one or an unfocused one isn't");

  const t = totals([...start, attempted(1, attempt({ rung: 3 }), check(50), baseline), { ...kept, i: 2 }, attempted(3, null, baseline, baseline)]);
  ok(t.attempts === 3 && t.kept === 1 && t.bestAt === 2, "totals: attempts, kept, and which made the best");
  ok(t.usage.usd === 0.02 && t.usage.input === 20 && t.startRung === 3, "totals: usage adds up; the start rung is the highest");
}

// --- brief options: --examples N and --spec
{
  const pool = [...Array.from({ length: 6 }, (_, k) => `Max("v${k}") expected "", got "x"`), ...Array.from({ length: 6 }, (_, k) => `Build("v${k}") expected "", got "x"`)];
  const own = Array.from({ length: 30 }, (_, k) => `Max("w${k}") expected "", got "y"`);
  const report = "Failures by function: Max 30/40, Build 6/10\nExample failures:\n- x\nTotal: 36 of 50 cases failed.";
  const base = { best: { failed: 36, total: 50 }, report, examples: pool, focus: { fn: "Max", failed: 30, total: 40 } };
  const shown = (b: string) => b.split("\n").filter((l) => l.startsWith("- ") && l.includes("expected"));
  const def = shown(buildBrief({ i: 1, ...base, focusExamples: own }));
  ok(def.length === 10 && def.every((l) => !l.includes("w")), "examples: without examplesPerBrief, focusExamples are ignored (default brief)");
  const n20 = shown(buildBrief({ i: 1, ...base, examplesPerBrief: 20, focusExamples: own }));
  ok(n20.length === 20 && n20.every((l) => l.startsWith('- Max("w')), "examples: N of the focus function's own cases");
  const n20b = shown(buildBrief({ i: 2, ...base, examplesPerBrief: 20, focusExamples: own }));
  ok(!eq(n20, n20b), "examples: the window rotates by attempt");
  const few = shown(buildBrief({ i: 1, ...base, examplesPerBrief: 20, focusExamples: own.slice(0, 3) }));
  ok(few.length === 9 && few.slice(0, 3).every((l) => l.includes("w")), "examples: fewer own than N are topped up from the pool");
  const noFocus = shown(buildBrief({ i: 1, ...base, focus: undefined, examplesPerBrief: 4 }));
  ok(noFocus.length === 4, "examples: without a focus, N from the pool");
  const spec = buildBrief({ i: 1, ...base, spec: "golang.org/x/mod/semver v0.21.0\n\nfunc Max(v, w string) string\n" });
  ok(spec.includes("Go's documentation for the package") && spec.includes("func Max(v, w string) string"), "spec: included when given");
  ok(!buildBrief({ i: 1, ...base }).includes("Go's documentation"), "spec: absent by default");
}

process.exit(failures ? 1 : 0);
