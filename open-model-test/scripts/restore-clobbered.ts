// Restore clobbered result rows from Inngest's own records (Finding 22
// addendum). execute-sample upserts are last-writer-wins; when a duplicate
// in-flight attempt (auto-retry racing a replay) fails AFTER a sibling
// attempt completed, the sibling's onFailure error row overwrites the
// completed outcome. This script finds the latest Completed
// inngest/function.finished event for each errored (model, task, sample)
// tuple of a run and rebuilds the row from the platform-recorded result
// plus the on-disk turn trace. No values are invented: every metric comes
// from the function result payload or turns.json.
//
// Usage: bun run scripts/restore-clobbered.ts <benchmarkRunId>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getResults, upsertResult, type ResultRow } from "../src/db";

const benchmarkRunId = process.argv[2];
if (!benchmarkRunId) {
  console.error("usage: bun run scripts/restore-clobbered.ts <benchmarkRunId>");
  process.exit(1);
}
const key = process.env.INNGEST_SIGNING_KEY;
if (!key) throw new Error("INNGEST_SIGNING_KEY required");

type Finished = {
  received_at: string;
  internal_id: string;
  data: {
    _inngest?: { status?: string };
    function_id?: string;
    run_id?: string;
    event?: { data?: { runId?: string; modelId?: string; taskId?: string; sample?: number; seed?: number } };
    result?: Record<string, unknown>;
  };
};

async function latestCompleted(model: string, task: string, sample: number): Promise<Finished | null> {
  let cursor: string | undefined;
  let best: Finished | null = null;
  for (let pages = 0; pages < 14; pages++) {
    const url = new URL("https://api.inngest.com/v1/events");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const batch = ((await res.json()) as { data?: Finished[] }).data ?? [];
    if (batch.length === 0) break;
    for (const ev of batch) {
      const d = ev.data;
      const p = d.event?.data;
      if (
        ev.received_at &&
        d.function_id === "open-model-test-execute-sample" &&
        d._inngest?.status === "Completed" &&
        d.result &&
        p?.runId === benchmarkRunId &&
        p.modelId === model &&
        p.taskId === task &&
        p.sample === sample &&
        (!best || ev.received_at > best.received_at)
      ) {
        best = { ...ev, received_at: ev.received_at };
      }
    }
    cursor = batch[batch.length - 1].internal_id;
  }
  return best;
}

const rows = getResults(benchmarkRunId).filter((r) => r.error !== null);
console.log(`errored rows: ${rows.length}`);
for (const row of rows as ResultRow[]) {
  const fin = await latestCompleted(row.model, row.task_id, row.sample);
  if (!fin) {
    console.warn(`  ${row.model}:${row.task_id}:s${row.sample} — no Completed run found, left as-is`);
    continue;
  }
  const r = fin.data.result as {
    compiled: number | null;
    testsPassed: number | null;
    testsTotal: number | null;
    turnsToGreen: number | null;
    turns: number;
    latencyMs: number | null;
    costUsd: number | null;
  };
  const payload = fin.data.event!.data!;
  const tracePath = join(
    "results",
    benchmarkRunId,
    "artifacts",
    row.model,
    row.task_id,
    `s${row.sample}`,
    "turns.json",
  );
  let trace: unknown[] = [];
  let tokensPrompt: number | null = null;
  let tokensCompletion: number | null = null;
  if (existsSync(tracePath)) {
    trace = JSON.parse(readFileSync(tracePath, "utf8")) as unknown[];
    const tp = (trace as { tokensPrompt: number | null }[]).reduce((a, t) => a + (t.tokensPrompt ?? 0), 0);
    const tc = (trace as { tokensCompletion: number | null }[]).reduce((a, t) => a + (t.tokensCompletion ?? 0), 0);
    if (tp > 0 || tc > 0) {
      tokensPrompt = tp;
      tokensCompletion = tc;
    }
  }
  upsertResult({
    ...row,
    seed: payload.seed ?? row.seed,
    compiled: r.compiled,
    tests_passed: r.testsPassed,
    tests_total: r.testsTotal,
    static_pass: null,
    static_issues: null,
    turns_to_green: r.turnsToGreen,
    agent_turns: r.turns,
    turns_trace: trace.length > 0 ? JSON.stringify(trace) : null,
    tokens_prompt: tokensPrompt,
    tokens_completion: tokensCompletion,
    ttft_ms: null,
    tokens_per_sec:
      tokensCompletion && r.latencyMs ? tokensCompletion / (r.latencyMs / 1000) : null,
    latency_ms: r.latencyMs,
    cost_usd: r.costUsd,
    stdout: null,
    stderr: null,
    error: null,
  });
  console.log(
    `  restored ${row.model}:${row.task_id}:s${row.sample} from run ${fin.data.run_id} (${fin.received_at}) — compiled=${r.compiled} tests=${r.testsPassed}/${r.testsTotal} green=${r.turnsToGreen !== null}`,
  );
}
console.log("done — re-aggregate next");
