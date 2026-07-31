import { MontyRunner } from "./monty";
import type { PythonRunner } from "./types";

// The single place the active Python backend is chosen — the whole point of the
// sandbox/ seam. Part 2 wires Monty (@pydantic/monty). To swap in Inngest
// Sandboxes later, add its runner and change this one line; nothing else in the
// app references a concrete backend. Fall back to the no-op PlaceholderRunner
// (./placeholder) if you need to run without an interpreter installed.
export const pythonRunner: PythonRunner = new MontyRunner();

export type { PythonRunner, PythonResult } from "./types";
