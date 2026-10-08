// pnpm check:harness — the harness's pure parts: the reasoning ladder, the
// loop's per-attempt bookkeeping, and history hygiene. No model, no Inngest.
import type { CheckResult } from "./types.js";
import type { AttemptResult } from "../src/inngest/agent-attempt.js";
import type { ChatResponse } from "../src/lib/model-call.js";
import { ReasoningLadder, type LadderOptions } from "../src/lib/reasoning-ladder.js";
import { afterAttempt, failedAttempt, initialState, JOURNAL_SIZE, type LoopState } from "../src/lib/loop-state.js";
import { assistantMessage, cutOffThinking, idleNudge } from "../src/lib/history.js";
import { buildBrief } from "../src/lib/prompt.js";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- fake responses
const thinkingCutoff: ChatResponse = {
  choices: [{ message: { content: null }, finish_reason: "length" }],
  usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3500 } },
};
const textCutoff: ChatResponse = {
  choices: [{ message: { content: "let me" }, finish_reason: "length" }],
  usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 100 } },
};
const chat: ChatResponse = { choices: [{ message: { content: "I will edit" }, finish_reason: "stop" }], usage: { completion_tokens: 10 } };
const acted: ChatResponse = {
  choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  usage: { completion_tokens: 20 },
};

// --- reasoning ladder
const ladder = (o: Partial<LadderOptions> = {}) =>
  new ReasoningLadder({ maxTokensPerTurn: 4000, maxTokensCap: 32_000, supportsReasoning: true, ...o });
{
  const l = ladder({ reasoningMaxTokens: 3000 });
  const seen: string[] = [];
  for (const res of [thinkingCutoff, thinkingCutoff, thinkingCutoff, acted]) {
    const t = l.turn();
    seen.push(`${t.maxTokens}:${JSON.stringify(t.reasoning)}`);
    l.observe(res);
  }
  ok(
    eq(seen, ['4000:{"max_tokens":2000}', '4000:{"max_tokens":2000}', '8000:{"max_tokens":3000}', '8000:{"enabled":false}']),
    "ladder: nudge only, then double once, then reasoning off; reasoning budget clamped to half",
  );
  ok(eq(l.learned(), { maxTokens: 8000, reasoningOff: true }), "ladder: learned after escalating and then acting");
}
{
  const l = ladder();
  l.observe(thinkingCutoff);
  l.observe(thinkingCutoff);
  ok(l.turn().maxTokens === 8000 && l.learned() === undefined, "ladder: escalated but never acted → nothing learned");
  const n = ladder();
  n.observe(acted);
  ok(n.learned() === undefined, "ladder: acted without escalating → nothing learned");
}
{
  const l = ladder({ effort: "high" });
  ok(eq(l.turn().reasoning, { effort: "high" }), "ladder: effort sent when no reasoning budget is set");
  ok(ladder().turn().reasoning === undefined, "ladder: no reasoning field when none is configured");
  ok(eq(ladder({ effort: "low", reasoningMaxTokens: 1000 }).turn().reasoning, { max_tokens: 1000 }), "ladder: token budget wins over effort");
}
{
  const l = ladder({ supportsReasoning: false, reasoningMaxTokens: 1000, start: { reasoningOff: true } });
  ok(l.turn().reasoning === undefined && !l.turn().reasoningOff, "ladder: never sends reasoning when unsupported");
  l.observe(thinkingCutoff);
  l.observe(thinkingCutoff);
  l.observe(thinkingCutoff);
  ok(l.turn().reasoning === undefined && l.turn().maxTokens === 8000, "ladder: unsupported → only the budget rung");
}
{
  const l = ladder({ maxTokensCap: 4000 });
  l.observe(thinkingCutoff);
  l.observe(thinkingCutoff);
  ok(l.turn().maxTokens === 4000 && eq(l.turn().reasoning, { enabled: false }) && l.turn().reasoningOff, "ladder: at the cap, the second cut-off turns reasoning off");
  const s = ladder({ start: { maxTokens: 16_000, reasoningOff: true } });
  ok(s.turn().maxTokens === 16_000 && eq(s.turn().reasoning, { enabled: false }), "ladder: starts where earlier attempts ended up");
  ok(ladder({ start: { maxTokens: 64_000 } }).turn().maxTokens === 32_000, "ladder: learned start is capped");
  const c = ladder();
  c.observe(textCutoff);
  c.observe(textCutoff);
  c.observe(chat);
  ok(c.turn().maxTokens === 4000, "ladder: cut-offs that weren't mostly reasoning don't climb");
  ok(ladder({ maxTokensPerTurn: 20_000 }).turn().timeoutMs === Math.max(Number(process.env.MODEL_TIMEOUT_MS) || 180_000, 300_000), "ladder: timeout grows with the budget");
}

// --- loop state
const check = (failed: number, o: Partial<CheckResult> = {}): CheckResult => ({
  commit: `c${failed}`,
  checkVersion: "v1",
  set: "train",
  total: 100,
  failed,
  score: failed / 100,
  pass: failed === 0,
  report: `${failed} failing`,
  byFn: { A: { total: 50, failed: Math.ceil(failed / 2) }, B: { total: 50, failed: Math.floor(failed / 2) } },
  ...o,
});
const attempt = (o: Partial<AttemptResult> = {}): AttemptResult => ({
  commit: "x",
  changed: true,
  summary: "did a thing",
  turns: 3,
  idleTurns: 0,
  tokens: { input: 10, output: 5 },
  finished: true,
  costUsd: 0.01,
  ...o,
});
const s0: LoopState = initialState(check(40));
{
  const kept = afterAttempt({ ...s0, stalls: 3, regressions: { i: 1, count: 2, examples: [] } }, { i: 2, attempt: attempt(), result: check(30) });
  ok(kept.outcome === "kept" && kept.state.best.failed === 30 && kept.state.stalls === 0, "loop: better score is kept, stalls reset");
  ok(kept.state.regressions === undefined, "loop: regressions cleared on keep");
  ok(eq(kept.state.journal[0]?.delta, { A: -5, B: -5 }), "loop: journal has the per-function delta");
  ok(kept.state.costUsd === 0.01 && kept.state.tokens.input === 10, "loop: totals add up");

  const rev = afterAttempt(s0, { i: 2, attempt: attempt(), result: check(50, { regressions: { count: 3, examples: ["A(x)"] } }) });
  ok(rev.outcome === "reverted" && rev.state.best.failed === 40 && rev.state.stalls === 1, "loop: worse score is reverted, stall counted");
  ok(eq(rev.state.regressions, { i: 2, count: 3, examples: ["A(x)"] }), "loop: regressions set on revert");

  const v2 = afterAttempt(s0, {
    i: 2,
    attempt: attempt(),
    result: check(50, { checkVersion: "v2", regressions: { count: 3, examples: [] } }),
    rebaselined: check(40, { checkVersion: "v2" }),
  });
  ok(v2.outcome === "reverted" && v2.state.regressions === undefined, "loop: regressions skipped when the check version changed");
  ok(v2.state.best.checkVersion === "v2", "loop: rebaselined incumbent becomes the best");

  const unchanged = afterAttempt(s0, { i: 2, attempt: attempt({ changed: false }), result: s0.best });
  ok(unchanged.outcome === "unchanged" && unchanged.state.journal[0]?.delta === undefined, "loop: no change → unchanged, no delta");
  const failed = afterAttempt(s0, { i: 2, attempt: failedAttempt(s0.best, "attempt failed"), result: s0.best });
  ok(failed.outcome === "failed" && failed.state.stalls === 1, "loop: a failed attempt → failed, a stall");
  const idleOnly = afterAttempt(s0, { i: 2, attempt: attempt({ changed: false, turns: 0, costUsd: 0 }), result: s0.best });
  ok(idleOnly.outcome === "unchanged", "loop: an attempt that ran but reported no turns or cost is unchanged, not failed");

  let s = s0;
  for (let i = 1; i <= 7; i++) s = afterAttempt(s, { i, attempt: attempt({ changed: false }), result: s.best }).state;
  ok(s.journal.length === JOURNAL_SIZE && s.journal[0]?.i === 3 && s.journal[4]?.i === 7, "loop: journal keeps the last 5");

  const focus = { fn: "A", failed: 20, total: 50 };
  const miss = afterAttempt(s0, { i: 2, attempt: attempt(), result: check(50), focus });
  ok(miss.state.focusMisses.A === 1, "loop: focused non-kept attempt counts a miss");
  ok(afterAttempt(s0, { i: 2, attempt: attempt(), result: check(30), focus }).state.focusMisses.A === undefined, "loop: kept focused attempt is no miss");
  ok(afterAttempt(s0, { i: 2, attempt: attempt(), result: check(50) }).state.focusMisses.A === undefined, "loop: unfocused attempt is no miss");
  ok(s0.focusMisses.A === undefined, "loop: input state not mutated");

  const l1 = afterAttempt(s0, { i: 1, attempt: attempt({ learned: { maxTokens: 16_000, reasoningOff: false } }), result: check(50) }).state;
  const l2 = afterAttempt(l1, { i: 2, attempt: attempt({ learned: { maxTokens: 8000, reasoningOff: true } }), result: check(50) }).state;
  const l3 = afterAttempt(l2, { i: 3, attempt: attempt(), result: check(50) }).state;
  ok(eq(l2.learned, { maxTokens: 16_000, reasoningOff: true }) && eq(l3.learned, l2.learned), "loop: learned only grows");
}

// --- history hygiene
ok(eq(assistantMessage(thinkingCutoff), { role: "assistant", content: "(no output)" }), "history: empty turn gets a placeholder");
ok(eq(assistantMessage(acted), { role: "assistant", content: null, tool_calls: acted.choices![0]!.message!.tool_calls }), "history: tool-call turn keeps content null");
const broken: ChatResponse = {
  choices: [{ message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "write_file", arguments: '{"path":"semver.ts","con' } }] }, finish_reason: "length" }],
};
const bm = assistantMessage(broken);
ok(bm.role === "assistant" && bm.tool_calls?.[0]?.function.arguments === "{}", "history: invalid tool-call arguments become {}");
const arr: ChatResponse = { choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "[1]" } }] } }] };
ok((assistantMessage(arr) as { tool_calls?: { function: { arguments: string } }[] }).tool_calls?.[0]?.function.arguments === "{}", "history: non-object JSON arguments become {}");
ok(cutOffThinking(thinkingCutoff) && !cutOffThinking(textCutoff), "history: cut off while thinking");
ok(idleNudge(chat) === "Use the tools, then call finish_attempt.", "nudge: plain chat turn");
ok(idleNudge(thinkingCutoff).startsWith("You ran out of room for this turn while thinking (3500 of 4000"), "nudge: cut off while thinking");
ok(idleNudge(textCutoff).startsWith("Your output was cut off before you made a tool call."), "nudge: cut off mid-text");

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
