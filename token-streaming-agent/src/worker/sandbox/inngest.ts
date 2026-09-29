import type { GetStepTools } from "inngest";
import { inngest } from "../../inngest/client";
import type { PythonResult } from "./types";

type Step = GetStepTools<typeof inngest>;

// Every sandbox a chat run creates is named with this prefix, so the failure
// and cancellation cleanup paths can find leftovers from a run they never saw
// create them. Lowercased: event ids are ULIDs, sandbox names are kept simple.
export function sandboxPrefix(eventId: string): string {
  return `tsa-${eventId.toLowerCase()}`;
}

// Runs inside the sandbox via `python3 -c`: decodes the payload from argv,
// binds each context value (e.g. `weather`) as a global, then runs the model's
// code as `main.py` so tracebacks point at the script's own line numbers.
const BOOTSTRAP = [
  "import base64, json, sys",
  "p = json.loads(base64.b64decode(sys.argv[1]))",
  'g = {"__name__": "__main__", **p["context"]}',
  'exec(compile(p["code"], "main.py", "exec"), g)',
].join("\n");

// Runs one model-written script in a fresh Inngest Sandbox. Create, exec, and
// destroy are each their own durable step (`${idBase}-create` etc.), so they
// show up individually in the run trace and memoize across replays.
//
// `step.sandbox` has no file upload, so the code and data travel as a single
// base64 argv entry. An argv array bypasses the shell, so there's no quoting to
// get wrong. A non-zero exit (syntax error, exception) is a normal outcome the
// model reads back and can fix; only sandbox/platform errors escape as step
// failures, which Inngest retries or records.
export async function runPythonInSandbox(
  step: Step,
  idBase: string,
  name: string,
  code: string,
  context: Record<string, unknown>,
): Promise<PythonResult> {
  const sandbox = await step.sandbox.create(`${idBase}-create`, {
    name,
    vcpu: 1,
    memoryMb: 1024,
    runningTimeout: "60s",
  });

  const payload = Buffer.from(JSON.stringify({ code, context })).toString("base64");
  const res = await sandbox.commands.run(`${idBase}-exec`, ["python3", "-c", BOOTSTRAP, payload], {
    cwd: "/tmp",
    timeout: "30s",
  });

  await sandbox.destroy(`${idBase}-destroy`);

  const ok = res.exitCode === 0;
  return {
    ok,
    stdout: res.stdout,
    stderr: res.stderr,
    ...(ok ? {} : { error: lastLine(res.stderr) || `python exited with code ${res.exitCode}` }),
  };
}

// Best-effort cleanup for a run that failed or was cancelled between a
// sandbox's create and destroy steps: destroys every sandbox whose name
// carries that run's prefix. Errors are swallowed — this runs from failure
// paths and must never mask the original error.
export async function destroyRunSandboxes(eventId: string): Promise<void> {
  const prefix = sandboxPrefix(eventId);
  try {
    let cursor: string | undefined;
    do {
      const { items, page } = await inngest.sandboxes.list({ cursor, limit: 100 });
      await Promise.allSettled(items.filter((s) => s.name.startsWith(prefix)).map((s) => s.destroy()));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch {
    // Nothing more to do; a leaked sandbox is reclaimed by the platform.
  }
}

// A Python traceback ends with the "ExceptionType: message" line — the most
// useful one-line summary for the model.
function lastLine(s: string): string {
  const lines = s.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
