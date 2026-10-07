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
// Call this inside one step.run (e.g. `check-3`): create, upload, exec,
// download and destroy then show up as one step in the trace, and a retry
// just builds a new sandbox (random name suffix, destroy in finally).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NonRetriableError } from "inngest";
import { inngest } from "../src/inngest/client.js";
import { CHECK_DIR } from "../src/lib/paths.js";
import { casesPath, scoreFromRunnerOutput } from "./score-core.js";
import type { CaseSet, CheckResult } from "./types.js";
import type { Files } from "../src/lib/backend.js";

export const SANDBOX_TIMEOUT_MS = 60_000;
const WORKDIR = "/workspace";
const VCPU = 1;
const MEMORY_MB = 512;
// Wait-until-running cap for create (client hard max is 300s).
const START_TIMEOUT = "120s";

const enc = new TextEncoder();

type Sb = NonNullable<Awaited<ReturnType<typeof inngest.sandboxes.get>>>;

// Upload, then verify the byte length landed by downloading it. SDK 4.18.1
// threw after a successful upload (string bytesWritten); the check stays as a
// cheap guard that also catches a short write.
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

export async function runCheckSandbox(opts: { files: Files; ref: string; set: CaseSet }): Promise<CheckResult> {
  if (process.env.INNGEST_DEV) {
    throw new NonRetriableError(
      "sandbox grader needs Inngest Cloud (sandboxes don't exist on the dev server): unset INNGEST_DEV and set INNGEST_SIGNING_KEY",
    );
  }
  const sb = await inngest.sandboxes.create({
    name: `goal-loop-${opts.set}-${opts.ref}-${randomBytes(3).toString("hex")}`,
    vcpu: VCPU,
    memoryMb: MEMORY_MB,
    runningTimeout: START_TIMEOUT,
  });
  try {
    // /workspace doesn't exist in the image, and a cwd that doesn't exist 400s.
    // Create every directory the workspace files need in the same call.
    const dirs = new Set([WORKDIR, `${WORKDIR}/src`]);
    for (const p of Object.keys(opts.files)) dirs.add(path.posix.dirname(`${WORKDIR}/src/${p}`));
    const mk = await sb.commands.run(["mkdir", "-p", ...dirs], { cwd: "/", timeout: "15s" });
    if (mk.exitCode !== 0) throw new Error(`mkdir ${WORKDIR} failed: ${mk.stderr.trim()}`);

    await upload(sb, "package.json", JSON.stringify({ type: "module" }));
    await upload(sb, "runner.ts", fs.readFileSync(path.join(CHECK_DIR, "runner.ts"), "utf8"));
    for (const [p, c] of Object.entries(opts.files)) await upload(sb, `src/${p}`, c);
    await upload(sb, "cases.jsonl", fs.readFileSync(casesPath(opts.set), "utf8"));

    let timedOut = false;
    try {
      await sb.commands.run(
        ["/bin/sh", "-c", "node runner.ts src/semver.ts cases.jsonl > out.jsonl 2> err.txt"],
        { cwd: WORKDIR, timeout: `${SANDBOX_TIMEOUT_MS}ms`, environment: { NODE_OPTIONS: "--max-old-space-size=256" } },
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "sandbox_exec_timed_out") throw e;
      timedOut = true;
    }

    // Partial output survives a timeout because the runner writes line by line.
    const dl = await sb.files.download({ path: `${WORKDIR}/out.jsonl` });
    const stdout = dl.ok ? await dl.text() : "";
    const { byFn: _byFn, ...scored } = scoreFromRunnerOutput({
      set: opts.set,
      stdout,
      timedOut,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    return { commit: opts.ref, ...scored };
  } finally {
    await sb.destroy().catch(() => {});
  }
}
