import { NonRetriableError } from "inngest";
import { inngest } from "../inngest/client";
import type { SandboxSession, SandboxSessionRequest, SessionFiles, Step, TurnResult } from "./runner";
import { parseGoTest, parseVitest } from "./local";

// Inngest Sandboxes session runner (experimental beta) — the isolated tier.
// One persistent VM per (model, task, sample): seeded once, written + built
// + tested per agentic turn, dumped and destroyed at loop end.
//
// Mapping to the beta's caveats (verified against the SDK surface):
//   - File upload/download is direct-client only (`inngest.sandboxes`), so
//     file ops attach via `inngest.sandboxes.get(id)` inside memoized
//     step.run calls; everything else rides durable step.sandbox steps.
//   - Create is idempotent by active-lifetime name (derived from
//     runId/modelId/taskId/sample), so a retried sample reattaches instead
//     of leaking a fresh VM.
//   - No custom images in the beta (SandboxCreateOptions has no image field;
//     imageRef is server-fixed). The image is documented as Node/Python/Ruby;
//     instead of hard-refusing Go we PROBE at open (`go version`) and fail
//     fast with a precise pointer if the toolchain is missing — if the beta
//     image grows Go, this runner starts working with zero changes.
//   - Commands are argument arrays; we invoke /bin/sh -c for task.yaml's
//     shell-string commands.
//   - Unexpected SandboxErrors escape untouched: Inngest retries retryable
//     ones; we never auto-repeat an exec that might have already run.

const WORKDIR = "/workspace";
const VCPU = 2;
const MEMORY_MB = 2048;
// Sessions now span multiple turns (generate+build+test each) plus model
// latency — the one-shot 90s budget would kill mid-loop sandboxes.
const RUNNING_TIMEOUT_S = 900;
const SEED_MARKER = `${WORKDIR}/.omt-seeded`;
const DUMP_MAX_FILES = 200;
const DUMP_MAX_BYTES = 256 * 1024;

const decoder = new TextDecoder();

function sh(cmd: string): string[] {
  return ["/bin/sh", "-c", cmd];
}

function pathPrefix(cmd: string): string {
  return `export PATH="${WORKDIR}/node_modules/.bin:$PATH"; ${cmd}`;
}

function record(
  label: string,
  out: string,
  err: string,
  r: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; output: { truncated: boolean } },
): { out: string; err: string; exit: number; stdout: string } {
  const stdout = decoder.decode(r.stdout);
  const stderr = decoder.decode(r.stderr);
  out += stdout ? `$ ${label}\n${stdout}\n` : "";
  err += stderr ? `$ ${label}\n${stderr}\n` : "";
  if (r.output.truncated) err += `$ ${label}: output truncated (tail retained)\n`;
  return { out, err, exit: r.exitCode, stdout };
}

async function uploadFiles(sandboxId: string, files: SessionFiles): Promise<number> {
  const direct = await inngest.sandboxes.get(sandboxId);
  if (!direct) throw new Error(`sandbox ${sandboxId} not found`);
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new NonRetriableError(`session file path escapes the workdir: ${JSON.stringify(path)}`);
    }
    await direct.files.upload({ path: `${WORKDIR}/${path}`, data: content });
  }
  return Object.keys(files).length;
}

export async function openInngestSession(step: Step, req: SandboxSessionRequest): Promise<SandboxSession> {
  if (process.env.INNGEST_DEV === "1") {
    throw new NonRetriableError(
      "sandbox.runner: inngest requires the cloud API (INNGEST_SIGNING_KEY); " +
        "the local dev server has no sandbox endpoint. Use runner: local for dev.",
    );
  }

  const secs = (n: number) => `${n}s`;
  const t = req.timeoutSeconds;

  const sandbox = await step.sandbox.create("sb-open", {
    name: req.sandboxName,
    vcpu: VCPU,
    memoryMb: MEMORY_MB,
    runningTimeout: secs(RUNNING_TIMEOUT_S),
  });

  // Probe the fixed image for the language toolchain BEFORE seeding: a
  // missing toolchain is a config mismatch (non-retriable), and failing 0.5s
  // in beats failing per-turn with mystery compile errors. Destroys the VM
  // so the probe failure doesn't leak it.
  const probeCmd =
    req.language === "go"
      ? "go version"
      : req.language === "typescript"
        ? "node --version"
        : null;
  if (!probeCmd) {
    await sandbox.destroy("sb-destroy");
    throw new NonRetriableError(`sandbox.runner: inngest cannot run language ${req.language}`);
  }
  try {
    const probe = await sandbox.commands.run("sb-probe", {
      command: sh(probeCmd),
      cwd: WORKDIR,
      timeout: secs(15),
    });
    if (probe.exitCode !== 0) {
      throw new NonRetriableError(
        `sandbox.runner: inngest beta image lacks the ${req.language} toolchain ` +
          `(probe \`${probeCmd}\` failed: ${decoder.decode(probe.stderr).trim()}). ` +
          "The beta ships a fixed image (no custom images yet) — use runner: local for this language.",
      );
    }

    // Seed once, marker-guarded: a dashboard re-run from step loses step
    // memoization, and re-seeding would clobber turn-1 model files.
    await step.run("sb-seed", async () => {
      const direct = await inngest.sandboxes.get(sandbox.id);
      if (!direct) throw new Error(`sandbox ${sandbox.id} not found`);
      try {
        const marker = await direct.files.download({ path: SEED_MARKER });
        if (marker.ok) return 0;
      } catch {
        // no marker yet — seed below
      }
      await direct.commands.run({
        command: sh(`mkdir -p ${WORKDIR}`),
        cwd: "/",
        timeout: secs(15),
      });
      const n = await uploadFiles(sandbox.id, { ...req.seedFiles, ...req.hiddenFiles });
      await direct.files.upload({ path: SEED_MARKER, data: new Date().toISOString() });
      return n;
    });

    if (req.installCommand) {
      // Image ships node/npm/npx — no bun. Cold npm cache per sandbox, so
      // installs get a wider budget than the task timeout.
      await sandbox.commands.run("sb-install", {
        command: sh(`cd ${WORKDIR} && npm install --no-audit --no-fund`),
        cwd: WORKDIR,
        timeout: secs(Math.max(t, 180)),
      });
    }
  } catch (e) {
    if (e instanceof NonRetriableError) {
      await sandbox.destroy("sb-destroy").catch(() => {});
    }
    throw e;
  }

  return {
    async turn(s, n, files): Promise<TurnResult> {
      const startedAt = Date.now();
      let out = "";
      let err = "";

      // Writes first (memoized, idempotent overwrites), then the gated
      // pipeline as durable command steps.
      await s.run(`turn-${n}-files`, () => uploadFiles(sandbox.id, files));

      // Build gate: compile fail → 0, tests/static skipped (null), not failed.
      const build = await sandbox.commands.run(`turn-${n}-build`, {
        command: sh(`cd ${WORKDIR} && ${pathPrefix(req.buildCommand)}`),
        cwd: WORKDIR,
        timeout: secs(t),
      });
      let rec = record(req.buildCommand, out, err, build);
      out = rec.out;
      err = rec.err;
      if (rec.exit !== 0) {
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

      const test = await sandbox.commands.run(`turn-${n}-test`, {
        command: sh(`cd ${WORKDIR} && ${pathPrefix(req.testCommand)}`),
        cwd: WORKDIR,
        timeout: secs(t),
      });
      rec = record(req.testCommand, out, err, test);
      out = rec.out;
      err = rec.err;

      // vitest writes .test-results.json (immune to the output cap); Go
      // streams go-test NDJSON on stdout. Download beats parsing capped
      // stdout when both exist.
      const counts = await s.run(`turn-${n}-read-results`, async () => {
        if (req.language === "go") return parseGoTest(rec.stdout);
        const direct = await inngest.sandboxes.get(sandbox.id);
        if (!direct) throw new Error(`sandbox ${sandbox.id} not found`);
        const res = await direct.files.download({ path: `${WORKDIR}/.test-results.json` });
        if (res.ok) return parseVitest(await res.text());
        return parseVitest(rec.stdout);
      });
      if (!counts && rec.exit === 0) {
        err += `$ ${req.testCommand}: passed but test counts unparseable — treat as unscored\n`;
      }

      let staticIssues = 0;
      for (let i = 0; i < req.staticChecks.length; i++) {
        const check = req.staticChecks[i];
        const r = await sandbox.commands.run(`turn-${n}-static-${i}`, {
          command: sh(`cd ${WORKDIR} && ${pathPrefix(check)}`),
          cwd: WORKDIR,
          timeout: secs(t),
        });
        rec = record(check, out, err, r);
        out = rec.out;
        err = rec.err;
        // Silent-on-clean convention (gofmt -l exits 0 while listing files).
        const clean = rec.exit === 0 && rec.stdout.trim() === "";
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
    },

    async close(s): Promise<{ files: SessionFiles }> {
      // Dump the final tree (failure-gallery artifact), then destroy the VM
      // on every exit path.
      const files = await s.run("sb-dump", async () => {
        const direct = await inngest.sandboxes.get(sandbox.id);
        if (!direct) throw new Error(`sandbox ${sandbox.id} not found`);
        const list = await direct.commands.run({
          command: sh(
            `cd ${WORKDIR} && find . -type f ` +
              `-not -path './node_modules/*' -not -path './.gocache/*' -not -path './.gopath/*' ` +
              `-not -name '.omt-*' -size -${DUMP_MAX_BYTES / 1024}c | head -${DUMP_MAX_FILES}`,
          ),
          cwd: WORKDIR,
          timeout: secs(30),
        });
        const dumped: SessionFiles = {};
        for (const raw of decoder.decode(list.stdout).split("\n")) {
          const rel = raw.trim().replace(/^\.\//, "");
          if (!rel) continue;
          try {
            const res = await direct.files.download({ path: `${WORKDIR}/${rel}` });
            if (res.ok) dumped[rel] = await res.text();
          } catch {
            // raced with destroy / unreadable — skip the file, keep the rest
          }
        }
        return dumped;
      });
      await sandbox.destroy("sb-destroy");
      return { files };
    },
  };
}
