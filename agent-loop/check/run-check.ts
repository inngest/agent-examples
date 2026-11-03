// The grader, run locally in a child process. Scores a semver implementation
// against a golden case set. The goal grades on its sandbox (check/grade.ts);
// this is for the selftests and for trying a file by hand.
// CLI: pnpm check -- --file workspace-template/src/semver.ts --set train
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { CHECK_DIR, REPO_ROOT } from "../src/lib/paths.js";
import { casesPath, scoreFromRunnerOutput, type ScoreResult } from "./score-core.js";
import type { CaseSet } from "./types.js";

export { computeCheckVersion, sanitizeError, type ScoreResult } from "./score-core.js";

export const TIMEOUT_MS = 30_000;

export async function scoreImpl(opts: {
  implPath: string;
  set: CaseSet;
  timeoutMs?: number;
  against?: string; // failBits to report regressions against
}): Promise<ScoreResult> {
  // NOTE: runs `node --import tsx`, not the tsx CLI. The tsx CLI spawns a grandchild and a
  // timeout kill leaves a spinning orphan behind (see BUILD_LOG.md).
  const res = await execa(
    process.execPath,
    ["--import", "tsx", path.join(CHECK_DIR, "runner.ts"), path.resolve(opts.implPath), casesPath(opts.set)],
    {
      cwd: REPO_ROOT,
      timeout: opts.timeoutMs ?? TIMEOUT_MS,
      killSignal: "SIGKILL",
      reject: false,
      stdin: "ignore",
      maxBuffer: 256 * 1024 * 1024,
      extendEnv: false,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_OPTIONS: "--max-old-space-size=256",
      },
    },
  );

  return scoreFromRunnerOutput({
    set: opts.set,
    stdout: String(res.stdout ?? ""),
    timedOut: Boolean(res.timedOut),
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    against: opts.against,
  });
}

// ---- CLI -------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = get("--file") ?? path.join(REPO_ROOT, "workspace-template", "src", "semver.ts");
  const set = (get("--set") ?? "train") as CaseSet;
  if (set !== "train" && set !== "holdout") {
    console.error("--set must be train or holdout");
    process.exit(2);
  }
  const t0 = Date.now();
  scoreImpl({ implPath: file, set })
    .then((r) => {
      if (r.report) console.log(r.report + "\n");
      console.log(JSON.stringify({ ...r, report: undefined, ms: Date.now() - t0 }, null, 2));
      process.exit(r.pass ? 0 : 1);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    });
}
