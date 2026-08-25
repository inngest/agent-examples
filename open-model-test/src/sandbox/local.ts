import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import type { SandboxSession, SandboxSessionRequest, SessionFiles, Step, TurnResult } from "./runner";

// Local session runner — the persistent-sandbox stand-in. A session is a
// named directory under the OS temp root:
// seeded once, written per turn, walked + removed at close. Because the dir
// is keyed by the deterministic sandbox name, a worker restart mid-loop
// reattaches to the same on-disk session instead of losing turn-1 state.
//
// Trust model: model-generated code runs ON THE HOST as the current user,
// with per-command timeouts and a trimmed environment (no API keys
// inherited). There is NO filesystem or network isolation. Acceptable for a
// private benchmark over self-authored tasks; the inngest runner is the
// isolated tier behind the same session interface.
//
// Static-check convention: a check passes iff it exits 0 AND prints nothing
// to stdout ("silent on clean"). `gofmt -l .` exits 0 while listing
// unformatted files, so exit code alone would lie.

const OUTPUT_CAP = 16 * 1024;
const SEED_MARKER = ".omt-seeded";
const INSTALL_MARKER = ".omt-installed";
// Dump caps: the artifact tree is for humans reading the failure gallery —
// caches and dependencies are noise, and unbounded dumps would be too.
const DUMP_SKIP_DIRS = new Set([".gocache", ".gopath", "node_modules", ".home", ".git"]);
const DUMP_MAX_FILES = 200;
const DUMP_MAX_FILE_BYTES = 256 * 1024;

export function sessionDir(sandboxName: string): string {
  const safe = sandboxName.replace(/[^a-zA-Z0-9-]/g, "-");
  return join(tmpdir(), "omt-sessions", safe);
}

type CmdResult = {
  exit: number | null;
  stdoutRaw: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

function truncate(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + "\n…[truncated]" : s;
}

function baseEnv(dir: string, goEnv: boolean): Record<string, string> {
  // Inherit the user's PATH/HOME so host toolchains resolve (node via volta/
  // nvm, go via brew) — a hardcoded PATH broke tsc ("env: node: No such file
  // or directory"). Secrets are scrubbed: model-spawned processes must never
  // see the worker's API keys.
  const SECRET_RE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(_|$)|^OPENROUTER_|^NEBIUS_|^INNGEST_/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  env.PATH = `${join(dir, "node_modules", ".bin")}:${env.PATH ?? ""}`;
  env.NO_COLOR = "1";
  env.CI = "1";
  if (goEnv) {
    // Hermetic-ish Go: caches inside the session dir, no toolchain
    // downloads, no cgo. Per-session dirs keep samples from interacting.
    env.GOCACHE = join(dir, ".gocache");
    env.GOPATH = join(dir, ".gopath");
    env.GOTOOLCHAIN = "local";
    env.GOFLAGS = "-mod=mod";
    env.CGO_ENABLED = "0";
  }
  return env;
}

async function runCmd(
  cmd: string,
  dir: string,
  timeoutSeconds: number,
  goEnv: boolean,
): Promise<CmdResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: dir,
    env: baseEnv(dir, goEnv),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutSeconds * 1000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    exit,
    stdoutRaw: stdout,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    timedOut: exit === null,
    durationMs: Date.now() - startedAt,
  };
}

// Writes a files map into the session dir. Paths come from model output —
// validated hard (relative, no traversal) since the local runner writes them
// to the real filesystem.
function writeSessionFiles(dir: string, files: SessionFiles): void {
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`session file path escapes the workspace: ${JSON.stringify(path)}`);
    }
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function walkForDump(dir: string): SessionFiles {
  const files: SessionFiles = {};
  const walk = (d: string) => {
    if (Object.keys(files).length >= DUMP_MAX_FILES) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".omt-")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!DUMP_SKIP_DIRS.has(entry.name)) walk(full);
      } else if (statSync(full).size <= DUMP_MAX_FILE_BYTES) {
        files[relative(dir, full)] = readFileSync(full, "utf8");
        if (Object.keys(files).length >= DUMP_MAX_FILES) return;
      }
    }
  };
  walk(dir);
  return files;
}

// vitest --reporter=json: one JSON object on stdout (possibly preceded by
// noise lines) with numTotalTests / numPassedTests at the top level.
export function parseVitest(stdout: string): { passed: number; total: number } | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const j = JSON.parse(stdout.slice(start, end + 1));
    if (typeof j.numTotalTests !== "number") return null;
    return { total: j.numTotalTests, passed: j.numPassedTests ?? 0 };
  } catch {
    return null;
  }
}

// go test -json: NDJSON events; a test's final Action decides its outcome.
// Subtests are distinct Test names — counted individually, which matches how
// vitest counts them.
export function parseGoTest(stdout: string): { passed: number; total: number } | null {
  const final = new Map<string, "pass" | "fail">();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (typeof ev.Test !== "string") continue; // package-level events
      if (ev.Action === "pass" || ev.Action === "fail") {
        final.set(`${ev.Package}/${ev.Test}`, ev.Action);
      }
    } catch {
      // partial line from a killed run — ignore
    }
  }
  if (final.size === 0) return null;
  let passed = 0;
  for (const action of final.values()) if (action === "pass") passed++;
  return { total: final.size, passed };
}

// One turn's gated pipeline, in one memoized step: write files → build →
// test → static. A step retry re-runs the whole turn deterministically
// (writes are idempotent overwrites), which is exactly the semantics the
// loop needs.
async function runTurn(dir: string, req: SandboxSessionRequest, files: SessionFiles): Promise<TurnResult> {
  const startedAt = Date.now();
  let out = "";
  let err = "";
  writeSessionFiles(dir, files);

  const go = req.language === "go";
  const t = req.timeoutSeconds;
  const append = (label: string, r: CmdResult) => {
    out += r.stdout ? `$ ${label}\n${r.stdout}\n` : "";
    err += r.stderr ? `$ ${label}\n${r.stderr}\n` : "";
    if (r.timedOut) err += `$ ${label}: timed out after ${t}s\n`;
  };

  // Build gate: "if it doesn't compile, it doesn't count" — tests and
  // static checks are skipped (null), not scored as failures.
  const build = await runCmd(req.buildCommand, dir, t, go);
  append(req.buildCommand, build);
  if (build.exit !== 0) {
    return {
      compiled: false,
      testsPassed: null,
      testsTotal: null,
      staticPass: null,
      staticIssues: null,
      stdout: out,
      stderr: err,
      durationMs: Date.now() - startedAt,
    };
  }

  const test = await runCmd(req.testCommand, dir, t, go);
  append(req.testCommand, test);
  // Parse from raw output (truncation is for storage only — failure stacks
  // can eat the JSON payload at the end of stdout). TS writes vitest JSON
  // to a file by convention; Go streams NDJSON on stdout.
  let counts: { passed: number; total: number } | null = null;
  if (go) {
    counts = parseGoTest(test.stdoutRaw);
  } else {
    const resultsPath = join(dir, ".test-results.json");
    counts = existsSync(resultsPath) ? parseVitest(readFileSync(resultsPath, "utf8")) : parseVitest(test.stdoutRaw);
  }
  if (!counts && test.exit === 0) {
    err += `$ ${req.testCommand}: passed but test counts unparseable — treat as unscored\n`;
  }

  let staticIssues = 0;
  for (const check of req.staticChecks) {
    const r = await runCmd(check, dir, t, go);
    append(check, r);
    const clean = r.exit === 0 && r.stdout.trim() === "";
    if (!clean) staticIssues++;
  }

  return {
    compiled: true,
    testsPassed: counts?.passed ?? null,
    testsTotal: counts?.total ?? null,
    staticPass: req.staticChecks.length > 0 ? staticIssues === 0 : null,
    staticIssues: req.staticChecks.length > 0 ? staticIssues : null,
    stdout: out,
    stderr: err,
    durationMs: Date.now() - startedAt,
  };
}

export async function openLocalSession(step: Step, req: SandboxSessionRequest): Promise<SandboxSession> {
  const dir = sessionDir(req.sandboxName);

  // Seed once. The marker guards re-execution after memoization loss
  // (dashboard re-run from step): without it, re-seeding would clobber
  // files the model wrote in turn 1.
  await step.run("sb-open", () => {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, SEED_MARKER))) {
      writeSessionFiles(dir, { ...req.seedFiles, ...req.hiddenFiles });
      writeFileSync(join(dir, SEED_MARKER), new Date().toISOString());
    }
    mkdirSync(join(dir, ".home"), { recursive: true });
    return dir;
  });

  if (req.installCommand) {
    await step.run("sb-install", async () => {
      if (existsSync(join(dir, INSTALL_MARKER))) return true;
      const r = await runCmd("bun install --silent", dir, Math.max(req.timeoutSeconds, 120), false);
      if (r.exit !== 0) throw new Error(`bun install failed: ${r.stderr}`);
      writeFileSync(join(dir, INSTALL_MARKER), new Date().toISOString());
      return true;
    });
  }

  return {
    async turn(s, n, files) {
      return s.run(`turn-${n}-sandbox`, () => runTurn(dir, req, files));
    },
    async close(s) {
      // Dump the final tree (failure-gallery artifact), then remove the
      // session. Empty when the session never got past open.
      return s.run("sb-close", () => {
        const files = existsSync(dir) ? walkForDump(dir) : {};
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        return { files };
      });
    },
  };
}
