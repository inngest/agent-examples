// The result of running a Python snippet in a sandbox. `stdout` is what the
// script printed (the model reads this back); `error` carries the exception
// line from a failed run. Kept backend-agnostic on purpose.
export type PythonResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
};
