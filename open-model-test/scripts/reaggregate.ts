// Re-triggers aggregate-run for a completed run (idempotent — reads the DB,
// rewrites rows.json/summary.json). Used after replaying failed samples.
//
//   bun run scripts/reaggregate.ts <runId>

import { inngest } from "../src/inngest/client";
import { EVENTS } from "../src/inngest/events";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: bun run scripts/reaggregate.ts <runId>");
  process.exit(1);
}

await inngest.send({
  name: EVENTS.runCompleted,
  data: { runId },
  meta: { sessions: { benchmark_run: runId } },
});
console.log(`run.completed sent for ${runId} — aggregate-run will rewrite results/${runId}/`);
