// pnpm check:sandbox-smoke — proves the sandbox grader end to end in a real
// Inngest Sandbox (needs Inngest Cloud: INNGEST_SIGNING_KEY, INNGEST_DEV unset).
// Stub fixture must score 1; the lookup fixture must score 0.
import fs from "node:fs";
import path from "node:path";
import { casesPath } from "./score-core.js";
import { runCheckSandbox } from "./run-check-sandbox.js";
import { computeCheckVersion } from "./run-check.js";
import { CHECK_DIR } from "../src/lib/paths.js";
import { sourceRef } from "../src/lib/backend.js";

let failures = 0;
// lookup-impl.ts reads ../../data at import time, which doesn't exist in a
// sandbox. Swap its table loader for the train answers inlined as JSON (train
// only: holdout cases never go into a sandbox for a train check).
function sandboxSource(name: string): string {
  const source = fs.readFileSync(path.join(CHECK_DIR, "fixtures", name), "utf8");
  if (name !== "lookup-impl.ts") return source;
  const entries = fs
    .readFileSync(casesPath("train"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { fn: string; args: unknown[]; expected: unknown })
    .map((c) => [c.fn + JSON.stringify(c.args), c.expected]);
  const table = `const table = new Map<string, unknown>(${JSON.stringify(entries)});\n\n`;
  return table + source.slice(source.indexOf("export function answer"));
}

async function run(name: string, expectScore: number) {
  const source = sandboxSource(name);
  const t = Date.now();
  const r = await runCheckSandbox({ source, ref: sourceRef(source), set: "train" });
  const good = r.score === expectScore && r.checkVersion === computeCheckVersion();
  console.log(`${good ? "PASS" : "FAIL"}  ${name}: score ${r.score} (${r.failed}/${r.total}), ${Date.now() - t}ms, checkVersion ${r.checkVersion}`);
  if (!good) {
    console.log(r.report);
    failures++;
  }
}

await run("stub-impl.ts", 1);
await run("lookup-impl.ts", 0);
process.exit(failures ? 1 : 0);
