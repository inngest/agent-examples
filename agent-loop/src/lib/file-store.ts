import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { REPO_ROOT, WORKSPACE_DIR, WORKSPACE_SRC } from "./paths.js";
import { WORKSPACE_PACKAGE_JSON, WORKSPACE_TSCONFIG } from "./workspace-files.js";

const TSC_TIMEOUT_MS = 60_000;

/**
 * What the agent's tools operate on. `resolve` is the path guard: it maps a
 * model-supplied path to a store key (or an error string for the model).
 * `drainChanges` is only meaningful for the in-memory store.
 */
export interface FileStore {
  resolve(requested: unknown, forWrite: boolean): Promise<{ key: string } | { error: string }>;
  list(): Promise<string[]>;
  read(key: string): Promise<string>;
  write(key: string, content: string): Promise<void>;
  typecheck(): Promise<{ ok: boolean; output: string }>;
  /** Files written since the last drain, as { "path relative to src/": contents }. */
  drainChanges?(): Record<string, string>;
}

const rejectPath = (requested: unknown, why: string) => {
  console.warn(`[path-guard] rejected path ${JSON.stringify(requested)}: ${why}`);
  return { error: `error: path ${JSON.stringify(requested)} is outside src/ or invalid (${why})` };
};

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

async function runTsc(cwd: string): Promise<{ ok: boolean; output: string }> {
  const tsc = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
  const r = await execa(tsc, ["--noEmit", "--pretty", "false"], {
    cwd,
    reject: false,
    timeout: TSC_TIMEOUT_MS,
    all: true,
  });
  if (r.timedOut) return { ok: false, output: `error: typecheck timed out after ${TSC_TIMEOUT_MS / 1000}s` };
  const output = String(r.all ?? "").trim();
  if (r.exitCode === 0) return { ok: true, output: "" };
  return { ok: false, output: output || `tsc exited with code ${r.exitCode}` };
}

/** Local backend: the git workspace on disk, path-guarded via realpath. */
export const localFsStore: FileStore = {
  async resolve(requested, forWrite) {
    if (typeof requested !== "string" || requested === "" || requested.includes("\0")) {
      return rejectPath(requested, "not a valid path string");
    }
    let root: string;
    try {
      root = await fs.realpath(WORKSPACE_SRC);
    } catch {
      return { error: "error: workspace src/ does not exist" };
    }
    const resolved = path.resolve(WORKSPACE_SRC, requested);
    if (!isInside(path.resolve(WORKSPACE_SRC), resolved)) return rejectPath(requested, "resolves outside src/");
    let real: string;
    try {
      real = await fs.realpath(resolved);
    } catch {
      if (!forWrite) return { error: `error: no such file ${JSON.stringify(requested)}` };
      try {
        real = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
      } catch {
        return { error: `error: directory for ${JSON.stringify(requested)} does not exist` };
      }
    }
    if (!isInside(root, real)) return rejectPath(requested, "real path escapes src/ (symlink?)");
    return { key: real };
  },
  async list() {
    const out: string[] = [];
    async function walk(dir: string) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(path.relative(WORKSPACE_SRC, p));
      }
    }
    await walk(WORKSPACE_SRC);
    return out;
  },
  read: (key) => fs.readFile(key, "utf8"),
  write: (key, content) => fs.writeFile(key, content, "utf8"),
  typecheck: () => runTsc(WORKSPACE_DIR),
};

/**
 * Sandbox backend: the workspace is an in-memory { "semver.ts": source } map
 * (paths relative to src/). Same guard semantics as the local store: relative
 * paths only, no "..", nothing outside src/, and a write needs an existing
 * directory. Typecheck writes the map to a fresh temp dir on the worker and
 * runs the project's tsc there; it never executes agent code.
 */
export function memoryStore(seed: Record<string, string>): FileStore {
  const files = new Map(Object.entries(seed));
  const changed = new Set<string>();
  return {
    async resolve(requested, forWrite) {
      if (typeof requested !== "string" || requested === "" || requested.includes("\0")) {
        return rejectPath(requested, "not a valid path string");
      }
      if (path.isAbsolute(requested) || requested.includes("\\")) return rejectPath(requested, "resolves outside src/");
      const key = path.posix.normalize(requested);
      if (key === ".." || key.startsWith("../") || requested.split("/").includes("..")) {
        return rejectPath(requested, "resolves outside src/");
      }
      if (!files.has(key)) {
        if (!forWrite) return { error: `error: no such file ${JSON.stringify(requested)}` };
        const dir = path.posix.dirname(key);
        const dirExists = dir === "." || [...files.keys()].some((k) => k.startsWith(dir + "/"));
        if (!dirExists) return { error: `error: directory for ${JSON.stringify(requested)} does not exist` };
      }
      return { key };
    },
    async list() {
      return [...files.keys()];
    },
    async read(key) {
      return files.get(key)!;
    },
    async write(key, content) {
      files.set(key, content);
      changed.add(key);
    },
    async typecheck() {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-loop-tc-"));
      try {
        await fs.writeFile(path.join(dir, "package.json"), WORKSPACE_PACKAGE_JSON);
        await fs.writeFile(path.join(dir, "tsconfig.json"), WORKSPACE_TSCONFIG);
        for (const [k, v] of files) {
          const p = path.join(dir, "src", k);
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, v, "utf8");
        }
        return await runTsc(dir);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
    drainChanges() {
      const out = Object.fromEntries([...changed].map((k) => [k, files.get(k)!]));
      changed.clear();
      return out;
    },
  };
}
