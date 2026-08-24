// Replays the compute_unavailable-failed samples of a run: sends the exact
// (runId, modelId, taskId, sample, seed) events again — results upsert, the
// completions tally is idempotent — then re-triggers aggregation. Used after
// the beta compute pool exhausted mid-run (Finding 22: 39/100 at 8-concurrent
// sandboxes). Restart the worker with reduced concurrency FIRST.
//
//   bun run scripts/replay-failed.ts <runId>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../src/inngest/client";
import { EVENTS } from "../src/inngest/events";
import { PROJECT_ROOT } from "../src/config";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: bun run scripts/replay-failed.ts <runId>");
  process.exit(1);
}

// Deterministic seed derivation — must match functions.ts seedFor (vary).
function hashSeed(...parts: string[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join(":")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const rows = JSON.parse(readFileSync(join(PROJECT_ROOT, "results", runId, "rows.json"), "utf8")) as Array<{
  model: string;
  task_id: string;
  sample: number;
  error: string | null;
}>;

const failed = rows.filter((r) => r.error);
if (failed.length === 0) {
  console.log("no failed samples to replay");
  process.exit(0);
}

const events = failed.map((r) => ({
  name: EVENTS.sampleRequested,
  data: {
    runId,
    modelId: r.model,
    taskId: r.task_id,
    sample: r.sample,
    seed: hashSeed(r.model, r.task_id, String(r.sample)),
  },
  meta: { sessions: { benchmark_run: runId } },
}));

console.log(`replaying ${events.length} failed samples of ${runId}...`);
await inngest.send(events);
console.log("sent. after they complete, re-aggregate:");
console.log(`  bun run scripts/reaggregate.ts ${runId}`);
