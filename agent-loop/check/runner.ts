// Executed in a child process by run-check.ts. Not imported by anything else.
//   node --import tsx check/runner.ts <impl.ts> <cases.jsonl>
// Writes one JSON line per case to stdout as it goes ({id, ok, actual?, error?}),
// synchronously, so partial progress survives a kill (timeout, OOM, infinite loop).
import fs from "node:fs";
import { pathToFileURL } from "node:url";

type Case = { id: string; fn: string; args: unknown[]; expected: unknown };

function writeLine(obj: unknown): void {
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; // pipe full; retry
      throw e;
    }
  }
}

function sameJson(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== typeof expected) return false;
  if (typeof actual === "number" && !Number.isFinite(actual)) return false;
  // -0 === 0 is accepted on purpose; JSON.stringify(-0) === "0".
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function clip(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + "..." : s;
}

async function main() {
  const [implPath, casesPath] = process.argv.slice(2);
  if (!implPath || !casesPath) {
    writeLine({ fatal: "usage: runner <impl> <cases>" });
    process.exit(2);
  }
  const cases: Case[] = fs
    .readFileSync(casesPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(implPath).href);
  } catch (e) {
    writeLine({ fatal: `failed to load implementation: ${e instanceof Error ? e.message : String(e)}` });
    process.exit(1);
  }

  for (const c of cases) {
    const fn = mod[c.fn];
    if (typeof fn !== "function") {
      writeLine({ id: c.id, ok: false, error: `missing export: ${c.fn}` });
      continue;
    }
    try {
      let actual: unknown;
      if (c.fn === "Sort") {
        const copy = [...(c.args[0] as string[])];
        const ret = (fn as (l: string[]) => unknown)(copy);
        actual = Array.isArray(ret) ? ret : copy;
      } else {
        actual = (fn as (...a: unknown[]) => unknown)(...c.args);
      }
      const ok = sameJson(actual, c.expected);
      writeLine(ok ? { id: c.id, ok } : { id: c.id, ok, actual: actual === undefined ? "undefined" : actual });
    } catch (e) {
      writeLine({ id: c.id, ok: false, error: clip(e instanceof Error ? e.message : String(e)) });
    }
  }
}

main().catch((e) => {
  writeLine({ fatal: `runner crashed: ${e instanceof Error ? e.message : String(e)}` });
  process.exit(1);
});
