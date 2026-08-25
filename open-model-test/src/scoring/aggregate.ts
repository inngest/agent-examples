import type { ResultRow, RunRow } from "../db";
import { mean, median, sampleFullyPasses, samplePassRate, variance } from "./stats";

// Pure aggregation over the committed result rows: reproducible from
// results/<run_id>/rows.json alone, no DB required.
//
// Every capability metric is segmented on BOTH axes: tier (difficulty) and
// task_type (workload — the headline cut).

export type TierSummary = {
  tier: string;
  tasks: number;
  passAtK: number | null;
  meanPassRate: number | null;
};

export type TaskTypeSummary = {
  task_type: string;
  tasks: number;
  passAtK: number | null;
  meanPassRate: number | null;
};

export type TurnsSummary = {
  // Median turns_to_green over samples that went green (null = none did).
  medianTurnsToGreen: number | null;
  // Share of sandbox-scored samples that went green within budget.
  greenWithinBudgetRate: number | null;
  // Median attempts used (green or not) — token/turn burn even on failure.
  medianTurnsUsed: number | null;
  // turns_to_green histogram: turn number (or "never") → sample count.
  greenByTurn: Record<string, number>;
};

export type ModelSummary = {
  model: string;
  tasks: number;
  samplesPerTask: number | null;
  // pass@k: mean over tasks of "at least one of the k samples passed all tests".
  passAtK: number | null;
  // Mean over all scored samples of testsPassed/testsTotal.
  meanPassRate: number | null;
  variancePassRate: number | null;
  compileRate: number | null;
  staticPassRate: number | null;
  turns: TurnsSummary;
  medianLatencyMs: number | null;
  medianTtftMs: number | null;
  medianTokensPerSec: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number;
  sandboxPendingSamples: number;
  failedSamples: number;
  byTier: TierSummary[];
  byTaskType: TaskTypeSummary[];
};

export type RunSummary = {
  runId: string;
  // Provenance: which code and which task suite produced this run.
  meta?: {
    createdAt: string;
    completedAt: string | null;
    harnessCommit: string | null;
    gitDirty: boolean | null;
    suiteHash: string | null;
    config: unknown;
    // The rate-card snapshot behind every cost number, keyed by model id —
    // committed cost stays auditable if a provider changes pricing after
    // the run. ttft/tokens_per_sec in the rows are provider-observed
    // (Nebius / OpenRouter serving), not local hardware.
    rateCard?: Record<string, { input_per_mtok: number; output_per_mtok: number }>;
  };
  models: ModelSummary[];
};

type Grouped = {
  taskIds: string[];
  byTask: Map<string, Map<number, ResultRow>>;
};

function groupByTask(rows: ResultRow[]): Grouped {
  const byTask = new Map<string, Map<number, ResultRow>>();
  for (const row of rows) {
    let samples = byTask.get(row.task_id);
    if (!samples) {
      samples = new Map();
      byTask.set(row.task_id, samples);
    }
    samples.set(row.sample, row);
  }
  return { taskIds: [...byTask.keys()].sort(), byTask };
}

// Per-segment accumulators, filled once per task while walking the model's
// rows — tier and task_type segmentations share the exact same logic.
type Segment = {
  taskCount: number;
  anyPassedFlags: number[];
  passRates: number[];
};

function segmentFor(map: Map<string, Segment>, key: string): Segment {
  let seg = map.get(key);
  if (!seg) {
    seg = { taskCount: 0, anyPassedFlags: [], passRates: [] };
    map.set(key, seg);
  }
  return seg;
}

function summarizeModel(model: string, rows: ResultRow[]): ModelSummary {
  const { byTask, taskIds } = groupByTask(rows);

  const perTaskAnyPassed: number[] = [];
  const tierSegs = new Map<string, Segment>();
  const typeSegs = new Map<string, Segment>();
  const passRates: number[] = [];
  const compileFlags: number[] = [];
  const staticFlags: number[] = [];
  const latencies: number[] = [];
  const ttfts: number[] = [];
  const tokensPerSec: number[] = [];
  const costs: number[] = [];
  const turnsToGreen: number[] = [];
  const turnsUsed: number[] = [];
  const greenByTurn: Record<string, number> = {};
  let scoredSamples = 0;
  let sandboxPending = 0;
  let failed = 0;

  for (const taskId of taskIds) {
    const samples = [...byTask.get(taskId)!.values()].sort((a, b) => a.sample - b.sample);
    const tier = samples[0]!.tier;
    const taskType = samples[0]!.task_type ?? "coding";
    const tierSeg = segmentFor(tierSegs, tier);
    const typeSeg = segmentFor(typeSegs, taskType);
    tierSeg.taskCount++;
    typeSeg.taskCount++;

    let anyPassed = false;
    let scoredAny = false;
    for (const s of samples) {
      if (s.error !== null) {
        failed++;
        continue;
      }
      // Cost/perf metrics are recorded for every generation regardless of
      // sandbox state — half the thesis (Y% cost, Z% latency) must survive
      // even while compile/test scoring is pending.
      if (s.latency_ms !== null) latencies.push(s.latency_ms);
      if (s.ttft_ms !== null) ttfts.push(s.ttft_ms);
      if (s.tokens_per_sec !== null) tokensPerSec.push(s.tokens_per_sec);
      if (s.cost_usd !== null) costs.push(s.cost_usd);
      if (s.compiled === null) {
        sandboxPending++;
        continue;
      }
      scoredAny = true;
      scoredSamples++;
      compileFlags.push(s.compiled === 1 ? 1 : 0);
      if (s.static_pass !== null) staticFlags.push(s.static_pass === 1 ? 1 : 0);
      const fully = sampleFullyPasses({
        compiled: s.compiled === 1,
        testsPassed: s.tests_passed,
        testsTotal: s.tests_total,
      });
      if (fully === true) anyPassed = true;
      if (s.turns_to_green !== null) {
        turnsToGreen.push(s.turns_to_green);
        greenByTurn[String(s.turns_to_green)] = (greenByTurn[String(s.turns_to_green)] ?? 0) + 1;
      } else {
        greenByTurn["never"] = (greenByTurn["never"] ?? 0) + 1;
      }
      if (s.agent_turns !== null) turnsUsed.push(s.agent_turns);
      const rate = samplePassRate({ compiled: s.compiled === 1, testsPassed: s.tests_passed, testsTotal: s.tests_total });
      if (rate !== null) {
        passRates.push(rate);
        tierSeg.passRates.push(rate);
        typeSeg.passRates.push(rate);
      }
    }
    // A task with zero sandbox-scored samples contributes no pass@k signal.
    if (scoredAny) {
      perTaskAnyPassed.push(anyPassed ? 1 : 0);
      tierSeg.anyPassedFlags.push(anyPassed ? 1 : 0);
      typeSeg.anyPassedFlags.push(anyPassed ? 1 : 0);
    }
  }

  const byTier: TierSummary[] = [...tierSegs.keys()].sort().map((tier) => {
    const seg = tierSegs.get(tier)!;
    return { tier, tasks: seg.taskCount, passAtK: mean(seg.anyPassedFlags), meanPassRate: mean(seg.passRates) };
  });
  const byTaskType: TaskTypeSummary[] = [...typeSegs.keys()].sort().map((task_type) => {
    const seg = typeSegs.get(task_type)!;
    return { task_type, tasks: seg.taskCount, passAtK: mean(seg.anyPassedFlags), meanPassRate: mean(seg.passRates) };
  });

  const sampleCounts = new Set(taskIds.map((id) => byTask.get(id)!.size));

  return {
    model,
    tasks: taskIds.length,
    samplesPerTask: sampleCounts.size === 1 ? [...sampleCounts][0]! : null,
    passAtK: mean(perTaskAnyPassed),
    meanPassRate: mean(passRates),
    variancePassRate: variance(passRates),
    compileRate: mean(compileFlags),
    staticPassRate: mean(staticFlags),
    turns: {
      medianTurnsToGreen: median(turnsToGreen),
      greenWithinBudgetRate: scoredSamples > 0 ? turnsToGreen.length / scoredSamples : null,
      medianTurnsUsed: median(turnsUsed),
      greenByTurn,
    },
    medianLatencyMs: median(latencies),
    medianTtftMs: median(ttfts),
    medianTokensPerSec: median(tokensPerSec),
    medianCostUsd: median(costs),
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    sandboxPendingSamples: sandboxPending,
    failedSamples: failed,
    byTier,
    byTaskType,
  };
}

export function computeSummary(runId: string, rows: ResultRow[], run?: RunRow | null): RunSummary {
  const models = [...new Set(rows.map((r) => r.model))].sort();
  return {
    runId,
    ...(run
      ? {
          meta: {
            createdAt: run.created_at,
            completedAt: run.completed_at,
            harnessCommit: run.harness_commit,
            gitDirty: run.git_dirty === null ? null : run.git_dirty === 1,
            suiteHash: run.suite_hash,
            config: JSON.parse(run.config_json),
            rateCard: rateCardFrom(run.config_json),
          },
        }
      : {}),
    models: models.map((m) => summarizeModel(m, rows.filter((r) => r.model === m))),
  };
}

// Pulls { model id → pinned pricing } out of the run's committed config so
// the summary carries its own rate-card snapshot. Defensive on shape: the
// config is harness-authored JSON, but old runs predate nothing here and a
// missing pricing block must not break re-aggregation.
function rateCardFrom(configJson: string): Record<string, { input_per_mtok: number; output_per_mtok: number }> | undefined {
  try {
    const cfg = JSON.parse(configJson) as { models?: { id: string; pricing?: { input_per_mtok: number; output_per_mtok: number } }[] };
    if (!Array.isArray(cfg.models)) return undefined;
    return Object.fromEntries(cfg.models.filter((m) => m.pricing).map((m) => [m.id, m.pricing!]));
  } catch {
    return undefined;
  }
}
