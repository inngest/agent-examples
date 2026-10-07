import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";

export type Backend = "local" | "sandbox";

/** Read at call time (not import time) so .env loading order doesn't matter. */
export function backend(): Backend {
  const v = process.env.WORKSPACE_BACKEND ?? "local";
  if (v !== "local" && v !== "sandbox") throw new Error(`WORKSPACE_BACKEND must be local or sandbox, got ${JSON.stringify(v)}`);
  return v;
}

/** Sandbox backend workspace: file contents keyed by path relative to src/. */
export type Files = Record<string, string>;

/** The sandbox backend's stand-in for a git commit: short content hash of every file (path + contents). */
export function filesRef(files: Files): string {
  const h = createHash("sha256");
  for (const p of Object.keys(files).sort()) h.update(p + "\0" + files[p] + "\0");
  return h.digest("hex").slice(0, 12);
}

/** The stub semver.ts a fresh workspace starts from. */
export const templateSource = (): string =>
  fs.readFileSync(path.join(REPO_ROOT, "workspace-template", "src", "semver.ts"), "utf8");

/** The files a fresh sandbox-backend workspace starts from. */
export const templateFiles = (): Files => ({ "semver.ts": templateSource() });
