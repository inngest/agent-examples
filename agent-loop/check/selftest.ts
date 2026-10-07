// pnpm check:selftest — validates the grader itself against known fixtures.
import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck, scoreImpl, computeCheckVersion, TIMEOUT_MS } from "./run-check.js";
import { CHECK_DIR, DATA_DIR } from "../src/lib/paths.js";

const fx = (n: string) => path.join(CHECK_DIR, "fixtures", n);
let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = Date.now();
  const r = await f();
  return [r, Date.now() - t];
};
const failedFns = (r: { byFn: Record<string, { failed: number }> }) =>
  Object.entries(r.byFn).filter(([, v]) => v.failed > 0).map(([k]) => k);

async function main() {
  // lookup: perfect, and deterministic
  const [l1, t1] = await time(() => scoreImpl({ implPath: fx("lookup-impl.ts"), set: "train" }));
  const l2 = await scoreImpl({ implPath: fx("lookup-impl.ts"), set: "train" });
  ok(l1.score === 0 && l1.pass && l1.total > 0, `lookup-impl train score 0 (${l1.failed}/${l1.total}, ${t1}ms)`);
  ok(JSON.stringify(l1) === JSON.stringify(l2), "lookup-impl results identical across two runs");
  const lh = await scoreImpl({ implPath: fx("lookup-impl.ts"), set: "holdout" });
  ok(lh.score === 0 && lh.report === "", `lookup-impl holdout score 0, report empty (${lh.failed}/${lh.total})`);

  // stub: everything fails
  const st = await scoreImpl({ implPath: fx("stub-impl.ts"), set: "train" });
  ok(st.score === 1 && !st.pass, `stub-impl score 1 (${st.failed}/${st.total})`);

  // isvalid-only
  const iv = await scoreImpl({ implPath: fx("isvalid-only.ts"), set: "train" });
  ok(iv.score > 0 && iv.score < 1, `isvalid-only 0 < score < 1 (${iv.score.toFixed(3)})`);
  ok(iv.byFn.IsValid.failed === 0 && !failedFns(iv).includes("IsValid") && failedFns(iv).length === Object.keys(iv.byFn).length - 1,
    `isvalid-only fails every fn except IsValid (failing: ${failedFns(iv).join(",")})`);

  // infinite loop: bounded by the timeout, selftest survives
  const [inf, tInf] = await time(() => scoreImpl({ implPath: fx("infinite-loop.ts"), set: "train", timeoutMs: 5000 }));
  ok(TIMEOUT_MS === 30_000, "default hard timeout is 30s");
  ok(inf.failed === inf.total && inf.score === 1 && tInf < 15_000, `infinite-loop: all ${inf.total} cases failed in ${tInf}ms (timeout override 5s)`);
  ok(/timed out/.test(inf.report), "infinite-loop report mentions timeout");

  // wrong-empty: fails exactly where the correct answer is ""
  const we = await scoreImpl({ implPath: fx("wrong-empty.ts"), set: "train" });
  const cases = fs.readFileSync(path.join(DATA_DIR, "cases.train.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const expectedEmpty = cases.filter((c) => c.expected === "" && !["IsValid", "Compare", "Sort"].includes(c.fn)).length;
  ok(we.failed === expectedEmpty && we.failed > 0, `wrong-empty fails exactly the ""-answer cases (${we.failed} == ${expectedEmpty})`);
  ok(!failedFns(we).includes("IsValid") && !failedFns(we).includes("Compare") && !failedFns(we).includes("Sort"), "wrong-empty only fails fns that can return \"\"");

  // checkVersion + report hygiene
  ok(computeCheckVersion() === computeCheckVersion() && /^[0-9a-f]{12}$/.test(computeCheckVersion()), "checkVersion stable, 12 hex chars");
  ok(l1.checkVersion === st.checkVersion, "checkVersion identical across scoreImpl calls");
  const holdoutIds = fs.readFileSync(path.join(DATA_DIR, "cases.holdout.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id as string);
  for (const [name, r] of [["stub", st], ["isvalid-only", iv], ["wrong-empty", we], ["infinite-loop", inf]] as const) {
    ok(!/holdout/i.test(r.report) && !holdoutIds.some((id) => r.report.includes(id)), `${name} train report has no holdout id/word`);
    ok(r.report.length <= 2048 && !r.report.includes(CHECK_DIR) && !/\/Users\//.test(r.report), `${name} report <= 2KB, no absolute paths (${r.report.length} chars)`);
  }
  console.log("\n--- sample report (isvalid-only) ---\n" + iv.report + "\n---");

  // end to end: temp git repo with the stub, runCheck through a worktree
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "goal-loop-selftest-"));
  const savedEnv = process.env.WORKSPACE_DIR;
  try {
    fs.mkdirSync(path.join(repo, "src"));
    fs.copyFileSync(fx("stub-impl.ts"), path.join(repo, "src", "semver.ts"));
    const g = (...a: string[]) => execa("git", a, { cwd: repo });
    await g("init", "-q");
    await g("config", "user.name", "t");
    await g("config", "user.email", "t@example.invalid");
    await g("add", "-A");
    await g("commit", "-q", "-m", "stub");
    process.env.WORKSPACE_DIR = repo;
    // paths.ts reads WORKSPACE_DIR at import time, so run the e2e in a fresh process
    const { stdout } = await execa("node", ["--import", "tsx", "-e", `
      import { runCheck } from "./check/run-check.ts";
      const r = await runCheck({ commit: "HEAD", set: "train" });
      console.log(JSON.stringify({ ...r, report: r.report.length }));
    `.replace(/^\s+/gm, ""), "--input-type=module"], { cwd: process.cwd(), env: { WORKSPACE_DIR: repo }, extendEnv: true });
    const r = JSON.parse(stdout.trim().split("\n").pop()!);
    ok(r.score === 1 && r.commit.length === 40 && r.set === "train", `e2e runCheck(stub commit) score 1, commit ${String(r.commit).slice(0, 8)}`);
    const wt = (await g("worktree", "list", "--porcelain")).stdout;
    ok(!wt.includes("check/.tmp"), "worktree removed after runCheck");
    ok(!fs.existsSync(path.join(CHECK_DIR, ".tmp")) || fs.readdirSync(path.join(CHECK_DIR, ".tmp")).length === 0, "check/.tmp left empty");
  } finally {
    if (savedEnv === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = savedEnv;
    fs.rmSync(repo, { recursive: true, force: true });
  }
  void runCheck;

  console.log(failures === 0 ? "\nselftest: all green" : `\nselftest: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("selftest crashed:", e);
  process.exit(1);
});
