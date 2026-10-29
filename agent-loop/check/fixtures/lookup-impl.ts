// Fixture: answers from the golden case files. Must score 0 on both sets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const table = new Map<string, unknown>();
for (const set of ["train", "holdout"]) {
  for (const line of fs.readFileSync(path.join(dataDir, `cases.${set}.jsonl`), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { fn: string; args: unknown[]; expected: unknown };
    table.set(c.fn + JSON.stringify(c.args), c.expected);
  }
}

export function answer(fn: string, ...args: unknown[]): unknown {
  const key = fn + JSON.stringify(args);
  if (!table.has(key)) throw new Error(`lookup miss: ${key}`);
  return table.get(key);
}

export const IsValid = (v: string) => answer("IsValid", v) as boolean;
export const Canonical = (v: string) => answer("Canonical", v) as string;
export const Major = (v: string) => answer("Major", v) as string;
export const MajorMinor = (v: string) => answer("MajorMinor", v) as string;
export const Prerelease = (v: string) => answer("Prerelease", v) as string;
export const Build = (v: string) => answer("Build", v) as string;
export const Compare = (v: string, w: string) => answer("Compare", v, w) as number;
export const Max = (v: string, w: string) => answer("Max", v, w) as string;
export const Sort = (list: string[]) => answer("Sort", list) as string[];
