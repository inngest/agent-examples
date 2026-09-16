// The result of running a Python snippet in a sandbox. `stdout` is what the
// script printed (the model reads this back); `result` is the repr of the final
// expression if the backend surfaces one; `error` carries an exception or a
// resource-limit message. Kept backend-agnostic on purpose.
export type PythonResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
};

// A pluggable Python execution backend. This is the seam that keeps the agent,
// the tool, and the UI ignorant of *how* Python runs: part 1 ships only a no-op
// PlaceholderRunner, part 2 adds a Monty-backed runner (@pydantic/monty), and an
// Inngest Sandboxes runner can replace it later — all behind this one interface.
// `context` is a map of host values to expose to the script as top-level
// variables (e.g. `{ weather: [...] }`), injected before the code runs.
export interface PythonRunner {
  run(code: string, context?: Record<string, unknown>): Promise<PythonResult>;
}
