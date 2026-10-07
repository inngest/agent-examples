import type { FileStore } from "../lib/file-store.js";

const MAX_WRITE_BYTES = 50 * 1024;
const MAX_READ_CHARS = 20_000;
const MAX_TSC_CHARS = 3_000;
const MAX_AUTO_TSC_CHARS = 2_000;

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List the files under src/ (paths relative to src/).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file under src/.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: 'Path relative to src/, e.g. "semver.ts"' } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create a new .ts file under src/, or fully rewrite one, with the complete given contents (max 50KB). Relative imports between your files must use the .ts extension (import { x } from \"./parse.ts\"). For targeted fixes to an existing file use edit_file instead. Runs the typechecker after writing and returns the result.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Path relative to src/, e.g. "semver.ts"' },
          content: { type: "string", description: "Complete new file contents" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Make a targeted edit to an existing .ts file under src/: replace old_string with new_string. old_string must match exactly once (include enough surrounding context to be unique). Prefer this over write_file for fixes. Runs the typechecker after editing and returns the result.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Path relative to src/, e.g. "semver.ts"' },
          old_string: { type: "string", description: "Exact text to replace; must occur exactly once in the file" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "typecheck",
      description: "Run the TypeScript compiler (tsc --noEmit) on the project and return any errors.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish_attempt",
      description: "End this attempt. Call once you have made your change (or if you think the check is wrong).",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "One sentence: what you changed or why you stopped." } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
];

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]` : s;

async function typecheck(store: FileStore): Promise<string> {
  const r = await store.typecheck();
  if (r.ok) return "typecheck passed: no errors";
  return truncate(r.output, MAX_TSC_CHARS);
}

/** Typecheck summary appended to write_file / edit_file results. */
async function autoTypecheck(store: FileStore): Promise<string> {
  const r = await store.typecheck();
  if (r.ok) {
    return "\n\ntypecheck: ok\n\nTypecheck passes. If this change addresses the check report, call finish_attempt now with a one-line summary.";
  }
  return `\n\ntypecheck errors:\n${truncate(r.output, MAX_AUTO_TSC_CHARS)}`;
}

/**
 * Result of one tool call. `finished` is set when the model called finish_attempt.
 * `changed` (in-memory store only) carries the files this call wrote, so the
 * caller can update its map from the step's return value.
 */
export type ToolOutput = { result: string; finished?: string; changed?: Record<string, string> };

export async function executeTool(store: FileStore, name: string, rawArgs: string): Promise<ToolOutput> {
  const out = await runTool(store, name, rawArgs);
  const changed = store.drainChanges?.();
  return changed && Object.keys(changed).length ? { ...out, changed } : out;
}

async function runTool(store: FileStore, name: string, rawArgs: string): Promise<ToolOutput> {
  let args: Record<string, unknown>;
  try {
    const parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
    args = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { result: "error: tool arguments were not valid JSON" };
  }
  try {
    switch (name) {
      case "list_files":
        return { result: ((await store.list()).sort().join("\n") || "(no files)") };
      case "read_file": {
        const g = await store.resolve(args.path, false);
        if ("error" in g) return { result: g.error };
        return { result: truncate(await store.read(g.key), MAX_READ_CHARS) };
      }
      case "write_file": {
        const g = await store.resolve(args.path, true);
        if ("error" in g) return { result: g.error };
        if (!g.key.endsWith(".ts")) return { result: "error: only .ts files can be written" };
        if (typeof args.content !== "string") return { result: "error: content must be a string" };
        const bytes = Buffer.byteLength(args.content, "utf8");
        if (bytes > MAX_WRITE_BYTES) return { result: `error: file too large (${bytes} bytes, max ${MAX_WRITE_BYTES})` };
        await store.write(g.key, args.content);
        return { result: `wrote ${bytes} bytes to ${String(args.path)}${await autoTypecheck(store)}` };
      }
      case "edit_file": {
        const g = await store.resolve(args.path, false);
        if ("error" in g) return { result: g.error };
        if (!g.key.endsWith(".ts")) return { result: "error: only .ts files can be edited" };
        if (typeof args.old_string !== "string" || args.old_string === "") {
          return { result: "error: old_string must be a non-empty string" };
        }
        if (typeof args.new_string !== "string") return { result: "error: new_string must be a string" };
        const oldString = args.old_string;
        const newString = args.new_string;
        if (newString === oldString) {
          return { result: "error: new_string is identical to old_string, so this edit changes nothing" };
        }
        const current = await store.read(g.key);
        const count = current.split(oldString).length - 1;
        if (count === 0) return { result: "error: old_string not found in file (0 matches); read_file and copy it exactly" };
        if (count > 1) {
          return { result: `error: old_string matches ${count} times; include more surrounding context so it matches exactly once` };
        }
        const idx = current.indexOf(oldString);
        const next = current.slice(0, idx) + newString + current.slice(idx + oldString.length);
        const bytes = Buffer.byteLength(next, "utf8");
        if (bytes > MAX_WRITE_BYTES) return { result: `error: file too large after edit (${bytes} bytes, max ${MAX_WRITE_BYTES})` };
        await store.write(g.key, next);
        return { result: `edited ${String(args.path)} (${bytes} bytes)${await autoTypecheck(store)}` };
      }
      case "typecheck":
        return { result: await typecheck(store) };
      case "finish_attempt": {
        const summary = typeof args.summary === "string" && args.summary ? args.summary : "(no summary)";
        return { result: "attempt finished", finished: summary };
      }
      default:
        return { result: `error: unknown tool ${JSON.stringify(name)}` };
    }
  } catch (err) {
    return { result: truncate(`error: ${err instanceof Error ? err.message : String(err)}`, 1000) };
  }
}
