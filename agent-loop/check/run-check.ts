// The grader. Scores a semver implementation against a golden case set.
//   scoreImpl: score one impl file (used by selftest and runCheck)
//   runCheck:  check a workspace commit out into a throwaway worktree and score it
// CLI: pnpm check -- --commit <sha|HEAD> --set train
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { CHECK_DIR, REPO_ROOT, WORKSPACE_DIR } from "../src/lib/paths.js";
import { casesPath, scoreFromRunnerOutput, type ScoreResult } from "./score-core.js";
import type { CaseSet, CheckResult } from "./types.js";

export { computeCheckVersion, sanitizeError, type ScoreResult } from "./score-core.js";

export const TIMEOUT_MS = 30_000;

// ---- scoring ---------------------------------------------------------------

export async function scoreImpl(opts: {
  implPath: string;
  set: CaseSet;
  timeoutMs?: number;
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
  });
}

// ---- worktree-based check --------------------------------------------------

const git = (cwd: string, args: string[]) => execa("git", args, { cwd, stdin: "ignore" });

export async function runCheck(opts: { commit: string; set: CaseSet }): Promise<CheckResult> {
  const tmpRoot = path.join(CHECK_DIR, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, `${Date.now()}-${randomBytes(4).toString("hex")}`);
  try {
    await git(WORKSPACE_DIR, ["worktree", "add", "--detach", dir, opts.commit]);
    const { stdout: sha } = await git(dir, ["rev-parse", "HEAD"]);
    const { byFn: _byFn, ...scored } = await scoreImpl({ implPath: path.join(dir, "src", "semver.ts"), set: opts.set });
    return { commit: sha.trim(), ...scored };
  } finally {
    await git(WORKSPACE_DIR, ["worktree", "remove", "--force", dir]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    await git(WORKSPACE_DIR, ["worktree", "prune"]).catch(() => {});
  }
}

// ---- CLI -------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const commit = get("--commit") ?? "HEAD";
  const set = (get("--set") ?? "train") as CaseSet;
  if (set !== "train" && set !== "holdout") {
    console.error("--set must be train or holdout");
    process.exit(2);
  }
  const t0 = Date.now();
  runCheck({ commit, set })
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
