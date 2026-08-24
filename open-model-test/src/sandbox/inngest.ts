import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { inngest } from "../inngest/client";
import { config, PROJECT_ROOT } from "../config";
import type { SandboxSession, SandboxSessionRequest, SessionFiles, Step, TurnResult } from "./runner";
import { parseGoTest, parseVitest } from "./local";

// Inngest Sandboxes session runner (beta) — the isolated tier. One persistent
// VM per (model, task, sample): seeded once, written + built + tested per
// agentic turn, dumped and destroyed at loop end.
//
// Phase A recon (2026-08-24, scripts/probe-*.ts, INNGEST-SANDBOX-BUGS.md)
// rewrote the assumptions this runner was originally coded against:
//
//   - The beta image is NixOS x86_64 (node 26, wget, tar, gzip; NO curl, NO
//     Go, NO bun) and the VPC is fully hermetic: no DNS, ENETUNREACH to every
//     public IP. Nothing can be downloaded from inside; the files API is the
//     only ingress.
//   - /workspace does not exist in the image. Bootstrap commands run with
//     cwd "/"; task commands get it mkdir'd first (bug S3: a cwd pointing at
//     a missing dir 400s with invalid_field_format).
//   - SDK 4.18.1 parse bugs (both still latest): exec results omit empty
//     stdout/stderr server-side but the client requires both (S1) — every
//     command is wrapped so both streams provably emit, preserving the real
//     exit code; files.upload succeeds then throws on a string bytesWritten
//     (S2) — uploads catch, then verify by download.
//   - runningTimeout is client-capped at 300s (the old 900s constant threw
//     SandboxValidationError at create). Sessions spanning model latency +
//     sandbox turns must fit; per-turn timeouts keep them well under.
//
// Go bootstrap: the worker downloads the pinned official tarball once
// (.cache/, sha256-verified), and each Go sandbox uploads it through the
// files API (~11.5s for 70.5MB), untars (1.8s), and runs with GOCACHE/GOPATH
// under /workspace and GOTOOLCHAIN=local (tasks pin go 1.24; no network means
// no toolchain auto-downloads anyway). Verified end-to-end offline: probe
// round 6, BUILD-OK in-VM.

const WORKDIR = "/workspace";
const VCPU = 2;
const MEMORY_MB = 2048;
const RUNNING_TIMEOUT_S = 300; // client hard cap (probe round 3)
const SEED_MARKER = `${WORKDIR}/.omt-seeded`;
const DUMP_MAX_FILES = 200;
const DUMP_MAX_BYTES = 256 * 1024;
const GO_VERSION = "1.27.0";
const GO_SHA256 = "675c26c449cbb18fc24b74650de1eabbae6e16f64326fd85a283fb3b58280685";
const GO_TARBALL_PATH = join(PROJECT_ROOT, ".cache", `go${GO_VERSION}.linux-amd64.tar.gz`);
// Toolchain + caches live OUTSIDE the workdir (/root, same disk): the tasks'
// own static checks (`gofmt -l .`, `go vet ./...`) run cwd-scoped in
// /workspace — shipping the toolchain inside it made them walk Go's own
// intentionally-malformed test fixtures (smoke-run 2026-08-24-535a3e,
// static_pass=0 with green tests).
const GO_ROOT = "/root/omt-go";
const GO_BIN = `${GO_ROOT}/go/bin`;

// S1 workaround: force both streams non-empty, preserve the real exit code.
// Markers are stripped client-side before any parsing.
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";
const MARKER_RE = (marker: string) => new RegExp(`\\n?${marker}\\d+\\n?$`);

function sh(cmd: string): string[] {
  return ["/bin/sh", "-c", cmd];
}

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

function stripMarkers(stdout: string, stderr: string): { stdout: string; stderr: string } {
  return {
    stdout: stdout.replace(MARKER_RE(SOUT), ""),
    stderr: stderr.replace(MARKER_RE(SERR), ""),
  };
}

const decoder = new TextDecoder();

interface RawResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

// Exec with the S1 wrapper applied. cwd must already exist (S3).
async function execRaw(
  run: (opts: { command: readonly string[]; cwd: string; timeout: string }) => Promise<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    output: { truncated: boolean };
  }>,
  cmd: string,
  cwd: string,
  timeoutS: number,
): Promise<RawResult> {
  const r = await run({ command: sh(wrap(cmd)), cwd, timeout: `${timeoutS}s` });
  const stripped = stripMarkers(decoder.decode(r.stdout), decoder.decode(r.stderr));
  return { exitCode: r.exitCode, ...stripped, truncated: r.output.truncated };
}

function pathPrefix(cmd: string): string {
  const env =
    `export GOCACHE=/root/.gocache GOPATH=/root/.gopath ` +
    `GOTOOLCHAIN=local HOME=/root PATH="${WORKDIR}/node_modules/.bin:${GO_BIN}:$PATH"; `;
  return env + cmd;
}

function record(label: string, out: string, err: string, r: RawResult): { out: string; err: string } {
  out += r.stdout ? `$ ${label}\n${r.stdout}\n` : "";
  err += r.stderr ? `$ ${label}\n${r.stderr}\n` : "";
  if (r.truncated) err += `$ ${label}: output truncated (tail retained)\n`;
  return { out, err };
}

// S2 workaround: upload (expecting the post-success throw), then verify the
// exact byte length landed via download size. readFileSync per call — the
// 70MB tarball must not be pinned in a worker's memory across samples.
async function uploadVerified(sandboxId: string, path: string, data: string | Uint8Array): Promise<void> {
  const direct = await inngest.sandboxes.get(sandboxId);
  if (!direct) throw new NonRetriableError(`sandbox ${sandboxId} not found`);
  try {
    await direct.files.upload({ path, data: data as unknown as ArrayBuffer });
  } catch {
    // S2: server returns bytesWritten as a string; the upload itself succeeded.
  }
  const expected = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  const dl = await direct.files.download({ path });
  const actual = new Uint8Array(await dl.arrayBuffer()).byteLength;
  if (actual !== expected) {
    throw new Error(`file upload verify failed for ${path}: wrote ${actual}, expected ${expected}`);
  }
}

async function uploadFiles(sandboxId: string, files: SessionFiles): Promise<number> {
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new NonRetriableError(`session file path escapes the workdir: ${JSON.stringify(path)}`);
    }
    await uploadVerified(sandboxId, `${WORKDIR}/${path}`, content);
  }
  return Object.keys(files).length;
}

function goTarball(): Uint8Array {
  try {
    const buf = readFileSync(GO_TARBALL_PATH);
    if (buf.byteLength < 1_000_000) throw new Error(`suspiciously small (${buf.byteLength} bytes)`);
    return new Uint8Array(buf);
  } catch (e) {
    throw new NonRetriableError(
      `Go tarball missing at ${GO_TARBALL_PATH} — run \`curl -fsSL -o ${GO_TARBALL_PATH} ` +
        `https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz\` (sha256 ${GO_SHA256}) before the run. ` +
        `Sandboxes have no egress; the toolchain ships via the files API. (${e instanceof Error ? e.message : e})`,
    );
  }
}

export async function openInngestSession(step: Step, req: SandboxSessionRequest): Promise<SandboxSession> {
  if (process.env.INNGEST_DEV === "1") {
    throw new NonRetriableError(
      "sandbox.runner: inngest requires the cloud API (INNGEST_SIGNING_KEY); " +
        "the local dev server has no sandbox endpoint. Use runner: local for dev.",
    );
  }

  const t = req.timeoutSeconds;

  const sandbox = await step.sandbox.create("sb-open", {
    name: req.sandboxName,
    vcpu: VCPU,
    memoryMb: MEMORY_MB,
    runningTimeout: `${RUNNING_TIMEOUT_S}s`,
  });

  try {
    // S3: /workspace doesn't exist in the image — create before any
    // cwd-scoped exec or file upload.
    const mk = await sandbox.commands.run("sb-mk-workspace", {
      command: sh(wrap(`mkdir -p ${WORKDIR}`)),
      cwd: "/",
      timeout: "15s",
    });
    if (mk.exitCode !== 0) {
      throw new Error(`mkdir ${WORKDIR} failed: ${decoder.decode(mk.stderr).trim()}`);
    }

    // Language runtime check. Go bootstraps from the uploaded tarball (probe
    // round 6); TS/Node ships with the image and needs no install (hermetic
    // VPC — npm install is impossible, tasks must be dependency-free).
    if (req.language === "go") {
      const probe = await execRaw((opts) => sandbox.commands.run("sb-go-probe", opts), `go version`, "/", 15);
      if (probe.exitCode !== 0) {
        const tarball = goTarball();
        // The tarball rides the direct files API (too big for step payloads);
        // wrap in a memoized step.run so retries skip the re-upload.
        await step.run("sb-upload-toolchain", async () => {
          await uploadVerified(sandbox.id, `${WORKDIR}/go.tgz`, tarball);
          return tarball.byteLength;
        });
        const untar = await sandbox.commands.run("sb-untar-go", {
          command: sh(
            wrap(
              `rm -rf ${GO_ROOT} && mkdir -p ${GO_ROOT} && tar -C ${GO_ROOT} -xzf ${WORKDIR}/go.tgz && ` +
                `rm ${WORKDIR}/go.tgz && ${GO_BIN}/go version`,
            ),
          ),
          cwd: "/",
          timeout: "120s",
        });
        if (untar.exitCode !== 0) {
          throw new Error(`Go toolchain install failed: ${decoder.decode(untar.stderr).trim()}`);
        }
      }
    } else if (req.language === "typescript") {
      const probe = await execRaw((opts) => sandbox.commands.run("sb-node-probe", opts), `node --version`, "/", 15);
      if (probe.exitCode !== 0) {
        throw new NonRetriableError(
          `sandbox.runner: inngest image lacks node (probe failed: ${probe.stderr.trim()})`,
        );
      }
      if (req.installCommand) {
        throw new NonRetriableError(
          "sandbox.runner: inngest sandboxes have no egress — npm install cannot run. " +
            "TS tasks must be dependency-free (node:test, no imports outside the stdlib).",
        );
      }
    } else {
      throw new NonRetriableError(`sandbox.runner: inngest cannot run language ${req.language}`);
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
      const n = await uploadFiles(sandbox.id, { ...req.seedFiles, ...req.hiddenFiles });
      await uploadVerified(sandbox.id, SEED_MARKER, new Date().toISOString());
      return n;
    });
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
      const build = await execRaw(
        (opts) => sandbox.commands.run(`turn-${n}-build`, opts),
        `cd ${WORKDIR} && ${pathPrefix(req.buildCommand)}`,
        WORKDIR,
        t,
      );
      let rec = record(req.buildCommand, out, err, build);
      out = rec.out;
      err = rec.err;
      if (build.exitCode !== 0) {
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

      const test = await execRaw(
        (opts) => sandbox.commands.run(`turn-${n}-test`, opts),
        `cd ${WORKDIR} && ${pathPrefix(req.testCommand)}`,
        WORKDIR,
        t,
      );
      rec = record(req.testCommand, out, err, test);
      out = rec.out;
      err = rec.err;

      // go test streams NDJSON on stdout; vitest writes .test-results.json
      // (immune to the output cap). Download beats parsing capped stdout
      // when both exist.
      const counts = await s.run(`turn-${n}-read-results`, async () => {
        if (req.language === "go") return parseGoTest(test.stdout);
        const direct = await inngest.sandboxes.get(sandbox.id);
        if (!direct) throw new Error(`sandbox ${sandbox.id} not found`);
        const res = await direct.files.download({ path: `${WORKDIR}/.test-results.json` });
        if (res.ok) return parseVitest(await res.text());
        return parseVitest(test.stdout);
      });
      if (!counts && test.exitCode === 0) {
        err += `$ ${req.testCommand}: passed but test counts unparseable — treat as unscored\n`;
      }

      let staticIssues = 0;
      for (let i = 0; i < req.staticChecks.length; i++) {
        const check = req.staticChecks[i];
        const r = await execRaw(
          (opts) => sandbox.commands.run(`turn-${n}-static-${i}`, opts),
          `cd ${WORKDIR} && ${pathPrefix(check)}`,
          WORKDIR,
          t,
        );
        rec = record(check, out, err, r);
        out = rec.out;
        err = rec.err;
        // Silent-on-clean convention (gofmt -l exits 0 while listing files).
        const clean = r.exitCode === 0 && r.stdout.trim() === "";
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
            wrap(
              `cd ${WORKDIR} && find . -type f ` +
                `-not -path './node_modules/*' -not -path './.gocache/*' -not -path './.gopath/*' ` +
                `-not -path './.gotoolchain/*' -not -name '.omt-*' -size -${DUMP_MAX_BYTES}c | head -${DUMP_MAX_FILES}`,
            ),
          ),
          cwd: WORKDIR,
          timeout: "30s",
        });
        const dumped: SessionFiles = {};
        for (const raw of stripMarkers(decoder.decode(list.stdout), "").stdout.split("\n")) {
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
