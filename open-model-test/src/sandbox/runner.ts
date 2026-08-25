import type { GetStepTools } from "inngest";
import type { inngest } from "../inngest/client";
import { config } from "../config";
import { hiddenDir, workspaceDir, loadDirFiles, type Task } from "../tasks";
import { openInngestSession } from "./inngest";
import { openLocalSession } from "./local";

// Sandbox session seam. A session is a persistent workspace that
// survives across agentic-loop turns: seeded once (workspace fixtures +
// hidden tests), written to per turn, evaluated per turn (build → test →
// static), and dumped + destroyed at loop end. State written in turn 1
// persists to turn 2 — that persistence is what makes the fix-loop honest.
//
// Implementations, selected by config (`sandbox.runner`):
//   - "inngest": real isolation via the Inngest Sandboxes beta (cloud-only;
//     turn 0 probes the fixed image for the language toolchain and fails
//     fast with a precise error if it's missing).
//   - "local": host execution in a named session dir under the OS temp root
//     — timeouts + scrubbed env, but NO isolation. Dev/private-benchmark mode.
//   - "stub": all-null turn results; rows stay sandbox-pending.
//
// Durable-execution contract: openSession may be called on every re-execution
// of the function body — each implementation is idempotent by sandbox name
// (inngest: name-keyed create; local: named dir + seed marker) so memoized
// step replay never re-seeds over model-written files.

export type SessionFiles = Record<string, string>;

export type SandboxSessionRequest = {
  language: Task["language"];
  // Deterministic per-sample identity: keys sandbox persistence across
  // turns AND makes create idempotent across retries.
  sandboxName: string;
  // workspace/ fixtures — seeded into the sandbox AND shown to the model.
  seedFiles: SessionFiles;
  // hidden/ tests — seeded into the sandbox, never shown to the model.
  hiddenFiles: SessionFiles;
  // Run once at open before turn 1 (e.g. dependency install); null = none.
  installCommand: string | null;
  buildCommand: string;
  testCommand: string;
  staticChecks: string[];
  // Per-command wall clock, applied to every turn's build/test/static.
  timeoutSeconds: number;
};

export type TurnResult = {
  compiled: boolean | null;
  testsPassed: number | null;
  testsTotal: number | null;
  staticPass: boolean | null;
  staticIssues: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

// Final file tree at loop end — the failure-gallery artifact.
export type SessionDump = { files: SessionFiles };

export interface SandboxSession {
  // Write this turn's files, then run the gated pipeline. Turn number keys
  // the durable step IDs (`turn-<n>-*`) so each turn memoizes independently.
  turn(step: Step, turn: number, files: SessionFiles): Promise<TurnResult>;
  // Dump the final tree, then destroy the session. Callers invoke this in a
  // finally block — it must run on every exit path.
  close(step: Step): Promise<SessionDump>;
}

export type Step = GetStepTools<typeof inngest>;

export function sessionRequestForTask(task: Task, sandboxName: string): SandboxSessionRequest {
  const wsDir = workspaceDir(task);
  return {
    language: task.language,
    sandboxName,
    seedFiles: wsDir ? loadDirFiles(wsDir) : {},
    hiddenFiles: loadDirFiles(hiddenDir(task)),
    // Go is self-contained (per-dir caches set by the runners); TS needs a
    // dependency install — the runners pick the right package manager for
    // their environment (bun locally, npm in the sandbox image).
    installCommand: task.language === "typescript" ? "install-deps" : null,
    buildCommand: task.build_command,
    testCommand: task.test_command,
    staticChecks: task.static_checks,
    timeoutSeconds: task.timeout_seconds,
  };
}

// Called at the top level of the function body (NOT inside step.run): the
// inngest runner issues its own durable step.sandbox operations with stable
// IDs; the local runner self-wraps in memoized step.run calls.
export async function openSession(step: Step, req: SandboxSessionRequest): Promise<SandboxSession> {
  switch (config.sandbox.runner) {
    case "inngest":
      return openInngestSession(step, req);
    case "local":
      return openLocalSession(step, req);
    case "stub":
    default:
      return {
        async turn(_step, turn) {
          console.warn(
            `[sandbox] stubbed — skipping turn ${turn} for ${req.sandboxName} ` +
              `(${Object.keys(req.seedFiles).length} seed files). Sandbox fields stay NULL.`,
          );
          return {
            compiled: null,
            testsPassed: null,
            testsTotal: null,
            staticPass: null,
            staticIssues: null,
            stdout: "",
            stderr: "sandbox not configured (stub)",
            durationMs: 0,
          };
        },
        async close() {
          return { files: {} };
        },
      };
  }
}
