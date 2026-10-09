import type { PythonResult, PythonRunner } from "./types";

// The part-1 stand-in for a real interpreter. It deliberately does NOT execute
// the code — generated Python must run only in a sandbox, and the sandbox
// (Monty) lands in part 2. It returns a well-formed, non-ok result so the whole
// pipeline — model → tool → trace UI → next turn — works end to end today; the
// model simply learns analysis isn't wired up yet. Part 2 swaps this out for a
// MontyRunner in sandbox/index.ts with no other change.
export class PlaceholderRunner implements PythonRunner {
  async run(_code: string, _context?: Record<string, unknown>): Promise<PythonResult> {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "Python sandbox not configured yet — Monty wiring lands in part 2.",
    };
  }
}
