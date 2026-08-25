import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TASKS_DIR } from "./tasks";
import { PROJECT_ROOT } from "./config";

// Run provenance — stamped into every run row and summary.json. The config is
// already recorded verbatim per run; these pin *which code* produced the run
// (enclosing git commit + dirty flag) and *which tasks* it ran (content hash
// of the tasks/ tree), so results/<run_id>/ is interpretable months later
// without archaeology.

export type HarnessVersion = {
  // Enclosing repo HEAD, or null when not inside a git repo. A real run
  // should carry a real commit: commit the harness first, or the stamp is
  // just the dirty flag.
  commit: string | null;
  // True when the harness tree has uncommitted/untracked changes (or git is
  // unavailable). Conservative: unknown state counts as not clean.
  dirty: boolean;
};

let cachedHarness: HarnessVersion | undefined;

export function harnessVersion(): HarnessVersion {
  if (cachedHarness) return cachedHarness;
  try {
    const commit = execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
    const status = execSync("git status --porcelain -- .", { cwd: PROJECT_ROOT, encoding: "utf8" });
    cachedHarness = { commit, dirty: status.trim().length > 0 };
  } catch {
    cachedHarness = { commit: null, dirty: true };
  }
  return cachedHarness;
}

let cachedSuiteHash: string | undefined;

// sha256 over the tasks/ tree: sorted relative paths + contents, so any edit
// to any task (prompt, hidden tests, pinned deps) changes the hash. This is
// the "suite version" — stronger than a git tag because it can't drift from
// the files that actually ran.
export function suiteHash(): string {
  if (cachedSuiteHash) return cachedSuiteHash;
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of [...readdirSync(dir, { withFileTypes: true })].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(relative(TASKS_DIR, full));
        hash.update("\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  walk(TASKS_DIR);
  cachedSuiteHash = hash.digest("hex");
  return cachedSuiteHash;
}
