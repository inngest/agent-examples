import { Monty, CollectStreams, MontyError, MontyRuntimeError } from "@pydantic/monty";
import type { PythonResult, PythonRunner } from "./types";

// Guard-rails for a single analysis run. Monty enforces these in-process (no
// container), so a script that loops forever or allocates wildly is bounded
// rather than taking the worker down with it.
const LIMITS = {
  maxDurationSecs: 5,
  maxMemory: 128 * 1024 * 1024, // 128 MiB
  maxRecursionDepth: 200,
};

// Monty-backed PythonRunner (part 2): runs the model's script in a Rust-based
// secure interpreter — no filesystem, env, or network access — with the host
// weather data injected as top-level Python variables via FeedOptions.inputs
// ("values bound as globals before the snippet runs"). Print output is captured
// with a CollectStreams sink so stdout/stderr come back to the model instead of
// leaking to the worker's console.
//
// The worker pool is created once and shared across tool calls — pool startup
// spins up worker subprocesses and is the expensive part; per-run `checkout`
// then returns a fresh isolated session in microseconds, which is disposed
// (returned to the pool) as soon as the run finishes.
export class MontyRunner implements PythonRunner {
  private poolPromise: Promise<Monty> | null = null;

  // Lazy so importing this module never spawns workers (keeps tooling/builds
  // side-effect free); a failed create is cleared so the next call retries.
  private pool(): Promise<Monty> {
    return (this.poolPromise ??= Monty.create());
  }

  async run(code: string, context?: Record<string, unknown>): Promise<PythonResult> {
    const streams = new CollectStreams();

    let pool: Monty;
    try {
      pool = await this.pool();
    } catch (err) {
      this.poolPromise = null;
      return { ok: false, stdout: "", stderr: "", error: `Python sandbox unavailable: ${message(err)}` };
    }

    try {
      // `await using` returns the session to the pool on scope exit, even if the
      // script throws — see MontySession[Symbol.asyncDispose].
      await using session = await pool.checkout({ limits: LIMITS });
      const value = await session.feedRun(code, {
        inputs: context ?? {},
        printCallback: streams,
      });
      const { stdout, stderr } = split(streams);
      return {
        ok: true,
        stdout,
        stderr,
        // Scripts do their work through print(), so the trailing expression is
        // usually None — only surface a result when there's a real value.
        ...(value !== undefined && value !== null ? { result: repr(value) } : {}),
      };
    } catch (err) {
      // A Python-level error (syntax, exception, or a hit resource limit) is a
      // normal outcome the model should see and can react to — not a run
      // failure. Return it as `ok:false` with whatever was printed first.
      const { stdout, stderr } = split(streams);
      return { ok: false, stdout, stderr, error: message(err) };
    }
  }
}

// Merge Monty's per-line stream entries into plain stdout/stderr strings.
function split(streams: CollectStreams): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  for (const e of streams.output) {
    if (e.stream === "stderr") stderr += e.text;
    else stdout += e.text;
  }
  return { stdout, stderr };
}

// A runtime error carries a Python-style traceback via display("traceback");
// other Monty errors (syntax, typing) render as "TypeName: message". Kept
// model-readable so it can fix its own script from the result.
function message(err: unknown): string {
  if (err instanceof MontyRuntimeError) return err.display("traceback");
  if (err instanceof MontyError) return err.display("type-msg");
  return err instanceof Error ? err.message : String(err);
}

function repr(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
