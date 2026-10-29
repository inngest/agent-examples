// The grader, sandbox flavour. Scores a source string in a fresh Inngest
// Sandbox that is created, used once and destroyed per call. Same CheckResult
// shape, report format and checkVersion as run-check.ts (all result logic is
// shared via score-core.ts).
//
// Only *executing* agent code is untrusted, so this is the only place a
// sandbox is used (typecheck runs on the worker). Sandboxes are cloud-only,
// have no network, and the files API is the only way in:
//   upload runner.ts + every workspace file under src/ (so a port split across
//   files still loads) + the ONE case file for the requested set (holdout
//   cases are only ever uploaded for set=holdout), exec plain
//   `node runner.ts` (node 26 native type stripping, so relative imports need
//   `.ts` specifiers), download the JSONL.
// The runner's stdout goes to a file and is downloaded: exec output is
// tail-truncated at a size cap and a full train run is >1MB of JSONL.
//
// Two ways to call it. runCheckSandbox does everything inside one step.run
// (e.g. `rebaseline-3`): create, upload, exec, download and destroy show up as
// one step in the trace, and a retry just builds a new sandbox (random name
// suffix, destroy in finally). runCheckSandboxSteps is called at function
// level and makes each phase its own step (`<id>-sandbox`, `-upload`, `-exec`,
// `-score`, `-destroy`), so the trace shows the sandbox. The create, exec and
// destroy steps are step.sandbox calls; files still go through the direct
// client because step.sandbox has no upload or download (and its exec output
// is capped and stored in step state).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GetStepTools } from "inngest";
import { NonRetriableError } from "inngest";
import { getSandboxError } from "inngest/experimental";
import { inngest } from "../src/inngest/client.js";
import { CHECK_DIR } from "../src/lib/paths.js";
import { casesPath, scoreFromRunnerOutput } from "./score-core.js";
import type { CaseSet, CheckResult } from "./types.js";
import type { Files } from "../src/lib/backend.js";

export const SANDBOX_TIMEOUT_MS = 60_000;
const WORKDIR = "/workspace";
const VCPU = 1;
// Smaller sizes got 503 compute_unavailable (see BUILD_LOG). The runner's own
// heap is still capped at 256MB via NODE_OPTIONS.
const MEMORY_MB = 1024;
// Wait-until-running cap for create (client hard max is 300s).
const START_TIMEOUT = "120s";

const EXEC_COMMAND = ["/bin/sh", "-c", "node runner.ts src/semver.ts cases.jsonl > out.jsonl 2> err.txt"];
const EXEC_ENV = { NODE_OPTIONS: "--max-old-space-size=256" };
const CREATE_OPTIONS = { vcpu: VCPU, memoryMb: MEMORY_MB, runningTimeout: START_TIMEOUT };

const enc = new TextEncoder();

type Step = GetStepTools<typeof inngest>;
type Sb = NonNullable<Awaited<ReturnType<typeof inngest.sandboxes.get>>>;

// Upload, then verify the byte length landed by downloading it. An upload
// error is ignored because some SDK versions threw after a successful upload;
// the download check is the real guard, and also catches a short write.
async function upload(sb: Sb, file: string, data: string): Promise<void> {
  const p = `${WORKDIR}/${file}`;
  try {
    await sb.files.upload({ path: p, data });
  } catch {
    // fall through to verification
  }
  const dl = await sb.files.download({ path: p });
  const got = (await dl.arrayBuffer()).byteLength;
  if (!dl.ok || got !== enc.encode(data).byteLength) {
    throw new Error(`sandbox upload verify failed for ${file}: got ${got} bytes`);
  }
}

// Same reading as the SDK: INNGEST_DEV=0 / false means Cloud.
function assertCloud(): void {
  const dev = (process.env.INNGEST_DEV ?? "").trim().toLowerCase();
  if (dev !== "" && dev !== "0" && dev !== "false") {
    throw new NonRetriableError(
      "sandbox grader needs Inngest Cloud (sandboxes don't exist on the dev server): unset INNGEST_DEV and set INNGEST_SIGNING_KEY",
    );
  }
}

// mkdir, then upload (and verify) everything the runner needs. Returns the
// file names and sizes (not contents) for a step result.
async function uploadWorkspace(sb: Sb, files: Files, set: CaseSet): Promise<Record<string, number>> {
  // /workspace doesn't exist in the image, and a cwd that doesn't exist 400s.
  // Create every directory the workspace files need in the same call.
  const dirs = new Set([WORKDIR, `${WORKDIR}/src`]);
  for (const p of Object.keys(files)) dirs.add(path.posix.dirname(`${WORKDIR}/src/${p}`));
  const mk = await sb.commands.run(["mkdir", "-p", ...dirs], { cwd: "/", timeout: "15s" });
  if (mk.exitCode !== 0) throw new Error(`mkdir ${WORKDIR} failed: ${mk.stderr.trim()}`);

  const all: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    "runner.ts": fs.readFileSync(path.join(CHECK_DIR, "runner.ts"), "utf8"),
    ...Object.fromEntries(Object.entries(files).map(([p, c]) => [`src/${p}`, c])),
    "cases.jsonl": fs.readFileSync(casesPath(set), "utf8"),
  };
  for (const [p, c] of Object.entries(all)) await upload(sb, p, c);
  return Object.fromEntries(Object.entries(all).map(([p, c]) => [p, enc.encode(c).byteLength]));
}

// Partial output survives a timeout because the runner writes line by line.
async function scoreSandbox(sb: Sb, opts: { ref: string; set: CaseSet; against?: string }, timedOut: boolean): Promise<CheckResult> {
  const dl = await sb.files.download({ path: `${WORKDIR}/out.jsonl` });
  const stdout = dl.ok ? await dl.text() : "";
  const scored = scoreFromRunnerOutput({
    set: opts.set,
    stdout,
    timedOut,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    against: opts.against,
  });
  return { commit: opts.ref, ...scored };
}

export async function runCheckSandbox(opts: { files: Files; ref: string; set: CaseSet; against?: string }): Promise<CheckResult> {
  assertCloud();
  const sb = await inngest.sandboxes.create({
    name: `goal-loop-${opts.set}-${opts.ref}-${randomBytes(3).toString("hex")}`,
    ...CREATE_OPTIONS,
  });
  try {
    await uploadWorkspace(sb, opts.files, opts.set);

    let timedOut = false;
    try {
      await sb.commands.run(EXEC_COMMAND, { cwd: WORKDIR, timeout: `${SANDBOX_TIMEOUT_MS}ms`, environment: EXEC_ENV });
    } catch (e) {
      if ((e as { code?: string }).code !== "sandbox_exec_timed_out") throw e;
      timedOut = true;
    }

    return await scoreSandbox(sb, opts, timedOut);
  } finally {
    await sb.destroy().catch(() => {});
  }
}

// The same check as runCheckSandbox, as separate steps (call at function
// level, not inside a step.run). `name` must be deterministic across replays
// (the create step is memoized by id, but the function body re-runs), so the
// caller derives it from the run id instead of a random suffix.
export async function runCheckSandboxSteps(
  step: Step,
  idBase: string,
  opts: { files: Files; ref: string; set: CaseSet; against?: string; name: string },
): Promise<CheckResult> {
  assertCloud();
  const sb = await step.sandbox.create(`${idBase}-sandbox`, { name: opts.name, ...CREATE_OPTIONS });
  try {
    await step.run(`${idBase}-upload`, async () => {
      const live = await inngest.sandboxes.get(sb.id);
      if (!live) throw new Error(`sandbox ${sb.id} not found`);
      return uploadWorkspace(live, opts.files, opts.set);
    });

    let timedOut = false;
    try {
      await sb.commands.run(`${idBase}-exec`, EXEC_COMMAND, {
        cwd: WORKDIR,
        timeout: `${SANDBOX_TIMEOUT_MS}ms`,
        environment: EXEC_ENV,
      });
    } catch (e) {
      // A failed step rejects with a StepError; the sandbox code is on its cause.
      if (getSandboxError(e)?.code !== "sandbox_exec_timed_out") throw e;
      timedOut = true;
    }

    return await step.run(`${idBase}-score`, async () => {
      const live = await inngest.sandboxes.get(sb.id);
      if (!live) throw new Error(`sandbox ${sb.id} not found`);
      return scoreSandbox(live, opts, timedOut);
    });
  } finally {
    await sb.destroy(`${idBase}-destroy`).catch(() => {});
  }
}
