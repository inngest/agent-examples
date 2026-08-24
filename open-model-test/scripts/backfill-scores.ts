// Backfill experiment-variant attribution for a completed run (Finding 22
// follow-up). The demo run scored samples with step.score() inside the
// variant callback, which (SDK 4.18.1 bug S4) writes score values but never
// the experiment metadata op — the Experiments dashboard therefore showed no
// variant data. This script reconstructs the attribution retroactively:
//
//   1. Page /v1/events for inngest/function.finished, function
//      execute-sample, status Completed, benchmark runId — each carries the
//      Inngest run_id plus the full sample payload (modelId, taskId, sample).
//   2. Join against the local results DB (authoritative metric values).
//   3. Re-emit every metric via inngest.score.experiment({ experiment:
//      {experimentName: "model-faceoff", variant: modelId}, runId }) — the
//      documented cross-run attribution path. Idempotent: score writes are
//      merges by name, so re-running is safe.
//
// Usage: bun run scripts/backfill-scores.ts <benchmarkRunId>
import { Inngest } from "inngest";
import { getResults } from "../src/db";

const benchmarkRunId = process.argv[2];
if (!benchmarkRunId) {
  console.error("usage: bun run scripts/backfill-scores.ts <benchmarkRunId>");
  process.exit(1);
}

const key = process.env.INNGEST_SIGNING_KEY;
if (!key) throw new Error("INNGEST_SIGNING_KEY required");

type FinishedEvent = {
  id: string;
  internal_id: string;
  received_at: string;
  data: {
    _inngest?: { status?: string };
    function_id?: string;
    run_id?: string;
    event?: { data?: { runId?: string; modelId?: string; taskId?: string; sample?: number } };
  };
};

// Page the events API newest-first (cursor = last internal_id of the prior
// page); collect completed execute-sample runs.
async function collectSampleRuns(): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // `${modelId}:${taskId}:${sample}` -> run_id
  let cursor: string | undefined;
  for (;;) {
    const url = new URL("https://api.inngest.com/v1/events");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`events API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data?: FinishedEvent[] };
    const batch = body.data ?? [];
    if (batch.length === 0) break;
    for (const ev of batch) {
      const d = ev.data;
      const payload = d.event?.data;
      if (
        d.function_id !== "open-model-test-execute-sample" ||
        d._inngest?.status !== "Completed" ||
        !d.run_id ||
        payload?.runId !== benchmarkRunId
      ) {
        continue;
      }
      const k = `${payload.modelId}:${payload.taskId}:${payload.sample}`;
      // Newest-first listing: first sighting per tuple is the latest run.
      if (!map.has(k)) map.set(k, d.run_id);
    }
    cursor = batch[batch.length - 1].internal_id;
    // The matrix started 2026-08-24T16:08Z; stop once past it.
    if (batch[batch.length - 1].received_at! < "2026-08-24T16:05") break;
  }
  return map;
}

const rows = getResults(benchmarkRunId);
if (rows.length === 0) throw new Error(`no results for ${benchmarkRunId}`);
const runMap = await collectSampleRuns();
console.log(`sample runs found: ${runMap.size}, db rows: ${rows.length}`);

const inngest = new Inngest({ id: "open-model-test", eventKey: process.env.INNGEST_EVENT_KEY });

let sent = 0;
let missing = 0;
for (const row of rows) {
  const k = `${row.model}:${row.task_id}:${row.sample}`;
  const runId = runMap.get(k);
  if (!runId) {
    console.warn(`  no run id for ${k} — skipped (metrics follow)`);
    missing++;
    continue;
  }
  const scores: Array<[string, number | boolean]> = [];
  if (row.compiled !== null) scores.push(["compiled", row.compiled === 1]);
  if (row.tests_total !== null && row.tests_total > 0 && row.tests_passed !== null) {
    scores.push(["test-pass-rate", row.tests_passed / row.tests_total]);
  }
  if (row.static_pass !== null) scores.push(["static-pass", row.static_pass === 1]);
  if (row.turns_to_green !== null) scores.push(["turns-to-green", row.turns_to_green]);
  if (row.latency_ms !== null) scores.push(["latency-ms", row.latency_ms]);
  if (row.tokens_per_sec !== null) scores.push(["tokens-per-sec", row.tokens_per_sec]);
  if (row.cost_usd !== null) scores.push(["cost-usd", row.cost_usd]);
  for (const [name, value] of scores) {
    await inngest.score.experiment({
      name,
      value,
      experiment: { experimentName: "model-faceoff", variant: row.model },
      runId,
    });
    sent++;
  }
}
console.log(`done: ${sent} scores attributed across ${rows.length - missing} runs (${missing} rows without run ids)`);
