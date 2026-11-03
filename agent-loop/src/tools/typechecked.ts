import { NonRetriableError } from "inngest";
import { tool, type SandboxTool, type SandboxToolContext } from "inngest/experimental";
import type { SandboxHandle } from "inngest/experimental/agents";

const MAX_TSC_CHARS = 2_000;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]` : s);

// Paths are relative to src/, but models often include it ("src/semver.ts",
// which is how the brief labels the code). Only the prefix is dropped.
const srcRelative = (p: string) => p.replace(/^\.\//, "").replace(/^src\//, "");

/**
 * A built-in file tool (`edit`, `write`) the way a small model needs it: a
 * leading `src/` is dropped, and every change is typechecked, so the model sees
 * the effect without spending a turn on it.
 */
export const typechecked = (inner: SandboxTool<{ path: string }, string>) => {
  // The built-in's own run, called with this call's context so it acts on the same sandbox.
  const innerRun = inner.run as (input: { path: string }, context: unknown) => Promise<string>;

  return tool.group({
    description: `${inner.description ?? ""} Paths are relative to src/. Runs the typechecker afterwards and returns the result.`,
    input: inner.input!,
    run: async (input: Record<string, unknown>, context: SandboxToolContext<SandboxHandle>) => {
      const { sandbox } = context;
      if (!sandbox) throw new NonRetriableError("typechecked tools work on a sandbox: list them in a sandbox's tools");

      const out = await innerRun({ ...input, path: srcRelative(String(input.path)) }, context);

      const tsc = await sandbox.$({ cwd: "/work", exitCodes: "any" })`tsc --noEmit -p .`;
      if (tsc.exitCode === 0) {
        return `${out}\n\ntypecheck: ok\n\nTypecheck passes. If this change addresses the check report, call work_finish now with a one-line summary.`;
      }
      return `${out}\n\ntypecheck errors:\n${truncate(`${tsc.stdout}${tsc.stderr}`, MAX_TSC_CHARS)}`;
    },
  });
};
