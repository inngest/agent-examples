// pnpm eval:report -- --batch <id>: one row per brief variant from the batch's
// goal/finished events (the terminal twin of the dashboard's Experiments page).
import { fetchEvents } from "../src/lib/goal-history.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const batch = args[args.indexOf("--batch") + 1];
if (args.indexOf("--batch") < 0 || !batch) {
  console.error("usage: pnpm eval:report -- --batch <id>");
  process.exit(2);
}

// goal ids are <batch>-<variant>-r<k>
const finished = (await fetchEvents("goal/finished")).filter((e) => String(e.data?.goalId).startsWith(`${batch}-`));
// Newest first, so the first one seen per goal is its latest.
const byGoal = new Map<string, (typeof finished)[number]["data"]>();
for (const e of finished) if (!byGoal.has(e.data.goalId)) byGoal.set(e.data.goalId, e.data);

const groups = new Map<string, (typeof finished)[number]["data"][]>();
for (const d of byGoal.values()) {
  const variant = d.variant ?? String(d.goalId).slice(batch.length + 1).replace(/-r\d+$/, "");
  groups.set(variant, [...(groups.get(variant) ?? []), d]);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([variant, ds]) => {
  const train = mean(ds.map((d) => 1 - d.best.score));
  const holdout = mean(ds.map((d) => 1 - d.holdout.score));
  return [
    variant,
    String(ds.length),
    pct(train),
    pct(holdout),
    pct(train - holdout),
    `${ds.filter((d) => d.holdout.pass).length}/${ds.length}`,
    mean(ds.map((d) => d.attempts)).toFixed(1),
    `$${mean(ds.map((d) => d.costUsd)).toFixed(2)}`,
  ];
});
if (!rows.length) {
  console.log(`no goal/finished events for batch ${batch} yet`);
  process.exit(0);
}
const head = ["variant", "n", "train pass", "holdout pass", "gap", "solved", "attempts", "cost"];
const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
for (const r of [head, ...rows]) console.log(r.map((cell, c) => cell.padEnd(widths[c]!)).join("  "));
