// Read-only export of a run's rows + summary to results/<run_id>/, plus a
// console master table. aggregate-run already writes these on completion;
// this script re-exports anytime (e.g. after adding a report format) without
// touching the DB read-write handle.
//
//   bun run export [runId]   (defaults to the latest run)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DB_PATH } from "../src/db";
import { PROJECT_ROOT } from "../src/config";
import { computeSummary } from "../src/scoring/aggregate";
import type { ResultRow, RunRow } from "../src/db";

// Read-only: never contends with the worker's write handle.
const db = new Database(DB_PATH, { readonly: true });

const runIdArg = process.argv[2] as string | undefined;
const run = runIdArg
  ? (db.query("SELECT * FROM runs WHERE run_id = ?").get(runIdArg) as RunRow | null)
  : (db.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").get() as RunRow | null);
if (!run) {
  console.error(runIdArg ? `no run ${runIdArg}` : "no runs yet");
  process.exit(1);
}

const rows = db.query("SELECT * FROM results WHERE run_id = ? ORDER BY model, task_id, sample").all(run.run_id) as ResultRow[];
const summary = computeSummary(run.run_id, rows, run);

const dir = join(PROJECT_ROOT, "results", run.run_id);
mkdirSync(dir, { recursive: true });
await Bun.write(join(dir, "rows.json"), JSON.stringify(rows, null, 2));
await Bun.write(join(dir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`exported ${rows.length} rows → results/${run.run_id}/{rows,summary}.json`);
if (summary.meta) {
  const commit = summary.meta.harnessCommit ?? "no-git";
  console.log(
    `harness ${commit.slice(0, 12)}${summary.meta.gitDirty ? " (dirty)" : ""} · suite ${summary.meta.suiteHash?.slice(0, 12)}`,
  );
}
console.log();

const header = ["model", "tasks", "pass@k", "pass rate", "compile", "med turns", "$/sample"];
console.log(header.join(" | "));
console.log(header.map(() => "---").join(" | "));
for (const m of summary.models) {
  console.log(
    [
      m.model,
      m.tasks,
      m.passAtK === null ? "n/a" : `${(m.passAtK * 100).toFixed(0)}%`,
      m.meanPassRate === null ? "n/a" : `${(m.meanPassRate * 100).toFixed(0)}%`,
      m.compileRate === null ? "n/a" : `${(m.compileRate * 100).toFixed(0)}%`,
      m.turns.medianTurnsToGreen === null ? "never" : `${m.turns.medianTurnsToGreen}`,
      m.medianCostUsd === null ? "n/a" : `$${m.medianCostUsd.toFixed(4)}`,
    ].join(" | "),
  );
}

// Dual-axis breakdown: workload type is the headline cut, tier is the
// difficulty gradient.
for (const m of summary.models) {
  if (m.byTaskType.length > 0) {
    console.log(`\n${m.model} by task_type:`);
    for (const t of m.byTaskType) {
      console.log(
        `  ${t.task_type.padEnd(16)} tasks=${t.tasks}  pass@k=${t.passAtK === null ? "n/a" : `${(t.passAtK * 100).toFixed(0)}%`}  mean=${t.meanPassRate === null ? "n/a" : `${(t.meanPassRate * 100).toFixed(0)}%`}`,
      );
    }
  }
  if (m.byTier.length > 0) {
    console.log(`${m.model} by tier:`);
    for (const t of m.byTier) {
      console.log(
        `  ${t.tier.padEnd(16)} tasks=${t.tasks}  pass@k=${t.passAtK === null ? "n/a" : `${(t.passAtK * 100).toFixed(0)}%`}  mean=${t.meanPassRate === null ? "n/a" : `${(t.meanPassRate * 100).toFixed(0)}%`}`,
      );
    }
  }
  const greenEntries = Object.entries(m.turns.greenByTurn);
  if (greenEntries.length > 0) {
    console.log(`${m.model} turns-to-green: ${greenEntries.sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}→${v}`).join("  ")}`);
  }
}
if (summary.models.some((m) => m.sandboxPendingSamples > 0)) {
  console.log("\n(sandbox-pending samples present — compile/pass columns will fill in once the sandbox runner lands)");
}
