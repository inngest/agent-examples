// The grader, run on the goal's grader sandbox (src/sandboxes.ts, which holds
// the cases). The sandbox only executes the candidate (runner.ts, uploaded from
// this deploy on every check); scoring, the report and checkVersion are
// computed here from the deployed check code. So a change to the grader reaches
// the next check after a deploy, checkVersion moves, and the goal re-scores.
import fs from "node:fs";
import path from "node:path";
import { step } from "inngest";
import { getCommandError } from "inngest/experimental";
import type { SandboxHandle } from "inngest/experimental/agents";
import { GRADER_TIMEOUT_MS } from "../src/config.js";
import type { Files } from "../src/lib/files.js";
import { CHECK_DIR } from "../src/lib/paths.js";
import { casesPath, scoreFromRunnerOutput } from "./score-core.js";
import type { CaseSet, CheckResult } from "./types.js";

/** A check of some code: what the grader said, and the code it graded. */
export type Graded = CheckResult & { files: Files };

/** Grades `at` (a commit and its files) against a case set. `id` names its steps. */
export async function grade(
  grader: Pick<SandboxHandle, "$" | "files">,
  id: string,
  at: { commit: string; files: Files },
  set: CaseSet,
  against?: string,
): Promise<Graded> {
  const inCheck = grader.$({ cwd: "/check" });

  // The holdout cases go up only to score the holdout, so they never exist in
  // a sandbox an attempt is graded in.
  if (set === "holdout") {
    await grader.files.write(`${id}-cases`, { path: "/check/cases.holdout.jsonl", data: fs.readFileSync(casesPath("holdout"), "utf8") });
  }

  // The candidate, and the runner from this deploy. Clear src/ first so a
  // file the last candidate had and this one doesn't can't load.
  await inCheck.sh`rm -rf src && mkdir -p src`;
  await grader.files.write(`${id}-runner`, { path: "/check/runner.ts", data: fs.readFileSync(path.join(CHECK_DIR, "runner.ts"), "utf8") });
  for (const [file, data] of Object.entries(at.files)) {
    await grader.files.write(`${id}-${file}`, { path: `/check/src/${file}`, data });
  }

  // Plain node (native type stripping). Partial output survives a timeout,
  // since the runner writes one line per case.
  let timedOut = false;
  try {
    await inCheck({ timeout: GRADER_TIMEOUT_MS, env: { NODE_OPTIONS: "--max-old-space-size=256" } })
      .sh`node runner.ts src/semver.ts ${`cases.${set}.jsonl`} > out.jsonl`;
  } catch (e) {
    if (getCommandError(e)?.type !== "timeout") throw e;
    timedOut = true;
  }
  const out = new TextDecoder().decode(await grader.files.read(`${id}-out`, "/check/out.jsonl"));

  const result = await step.run(`${id}-score`, () => scoreFromRunnerOutput({ set, stdout: out, timedOut, timeoutMs: GRADER_TIMEOUT_MS, against }));
  return { ...result, commit: at.commit, files: at.files } as Graded;
}
