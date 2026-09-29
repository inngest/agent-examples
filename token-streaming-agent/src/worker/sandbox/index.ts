// The Python backend for run_python: Inngest Sandboxes (./inngest). Each call
// gets its own isolated Linux VM, created, used, and destroyed as durable steps.
export { runPythonInSandbox, destroyRunSandboxes } from "./inngest";
export type { PythonResult } from "./types";
