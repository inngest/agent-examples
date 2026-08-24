import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { NonRetriableError, experiment, slugify } from "inngest";
import { config, PROJECT_ROOT } from "../config";
import { loadTask, loadTasks } from "../tasks";
import { createRun, getRun, getResults, markRunStatus, recordCompletion, completionCount, upsertResult } from "../db";
import { harnessVersion, suiteHash } from "../version";
import { createAdapter, buildGenerationRequest, type GenerationResult } from "../models/adapter";
import { extractFiles } from "../extract";
import { openSession, sessionRequestForTask, type SandboxSession, type Step } from "../sandbox/runner";
import { computeSummary } from "../scoring/aggregate";
import { inngest } from "./client";
import {
  EVENTS,
  RunCompletedSchema,
  RunRequestedSchema,
  SampleCompletedSchema,
  SampleRequestedSchema,
} from "./events";

// Deterministic 32-bit FNV-1a over the joined parts: retried samples reuse
// the same seed because it derives purely from the event identity.
function hashSeed(...parts: string[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join(":")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function newRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${crypto.randomUUID().slice(0, 6)}`;
}

// seed_policy: "vary" derives the seed per (model, task, sample); "fixed"
// pins one seed per (model, task) so every sample shares it.
function seedFor(modelId: string, taskId: string, sample: number): number {
  if (config.run.seed_policy === "fixed") {
    return hashSeed(modelId, taskId);
  }
  return hashSeed(modelId, taskId, String(sample));
}

// Host binaries each suite language needs on PATH (local runner). Probed
// through the same `bash -c` + inherited-env mechanism the runner uses, so
// "probed" means "will actually resolve", not "is installed somewhere".
const LOCAL_TOOLCHAINS: Record<string, string[]> = {
  go: ["go", "gofmt"],
  typescript: ["bun"],
};

// Harness bug #8 (2026-08-21): the host Go toolchain had been removed and a
// full A/A run scored 16/16 samples compile-fail with `bash: go: command
// not found` — $0.055 of model spend producing a 0% that looked like a model
// result. Environment must be validated before any spend, the same way task
// suites are validated with known-bad solutions before models see them.
async function checkLocalToolchains(tasks: { language: string }[]): Promise<string[]> {
  const langs = [...new Set(tasks.map((t) => t.language))];
  const missing: string[] = [];
  for (const lang of langs) {
    for (const bin of LOCAL_TOOLCHAINS[lang] ?? []) {
      const proc = Bun.spawn(["bash", "-c", `command -v ${bin} >/dev/null 2>&1`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      if (code !== 0) missing.push(`${bin} (needed by ${lang} tasks)`);
    }
  }
  if (missing.length > 0) {
    throw new NonRetriableError(
      `local sandbox runner: toolchain missing from the worker's PATH — ${missing.join("; ")}. ` +
        `Install them and relaunch the worker BEFORE triggering a run: samples would otherwise ` +
        `burn model spend on guaranteed compile-fails.`,
    );
  }
  return langs;
}

// -- orchestrate-run ---------------------------------------------------------

export const orchestrateRun = inngest.createFunction(
  { id: "orchestrate-run", retries: 3, triggers: [{ event: EVENTS.runRequested }] },
  async ({ event, step }) => {
    const parsed = RunRequestedSchema.safeParse(event.data ?? {});
    if (!parsed.success) {
      throw new NonRetriableError(`invalid run event: ${parsed.error.message}`);
    }

    // run.tasks (optional config): restrict the matrix to a subset — the
    // Δ4 A/A run slices a few tasks per axis instead of paying for the
    // full suite twice. Unknown ids fail fast rather than silently
    // shrinking the matrix.
    const tasks = await step.run("load-suite", () => {
      const all = loadTasks();
      const wanted = config.run.tasks;
      if (!wanted) return all;
      const known = new Set(all.map((t) => t.id));
      const missing = wanted.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new NonRetriableError(`config run.tasks references unknown task ids: ${missing.join(", ")}`);
      }
      return all.filter((t) => wanted.includes(t.id));
    });

    // Fail fast on a broken execution environment (see checkLocalToolchains):
    // one step, before create-run/fan-out — zero model spend.
    if (config.sandbox.runner === "local") {
      await step.run("check-toolchains", () => checkLocalToolchains(tasks));
    }

    const runId = await step.run("create-run", () => {
      const id = parsed.data.runId ?? newRunId();
      const expected = config.models.length * tasks.length * config.run.k_samples;
      // INSERT OR IGNORE keeps a mid-step-crash retry idempotent; the SELECT
      // detects a genuinely pre-existing run id (caller error, non-retriable).
      // The version stamp (commit + dirty flag + suite hash) is captured once
      // here, at run start.
      const { commit, dirty } = harnessVersion();
      createRun(id, expected, JSON.stringify(config), {
        harnessCommit: commit,
        gitDirty: dirty,
        suiteHash: suiteHash(),
      });
      const existing = getRun(id);
      if (existing && existing.expected_samples !== expected) {
        throw new NonRetriableError(`run id already exists with a different matrix: ${id}`);
      }
      return id;
    });

    const events = config.models.flatMap((model) =>
      tasks.flatMap((task) =>
        Array.from({ length: config.run.k_samples }, (_, sample) => ({
          name: EVENTS.sampleRequested,
          data: {
            runId,
            modelId: model.id,
            taskId: task.id,
            sample,
            seed: seedFor(model.id, task.id, sample),
          },
        })),
      ),
    );

    await step.sendEvent("fan-out-samples", events);

    return { runId, samples: events.length, tasks: tasks.length, models: config.models.length };
  },
);

// -- execute-sample (one function, models as experiment variants) -------------
//
// A single function for every model in the matrix. The model is a VARIANT of
// the "model-faceoff" step experiment: selection is deterministic from the
// event (experiment.fixed(modelId)), so each sample runs exactly its own
// model's variant, and every step.score() inside the variant callback is
// attributed to that variant — the dashboard shows both models' score
// distributions side by side on one experiment. Per-model concurrency is
// preserved via a keyed limit on event.data.modelId.
//
// The body is the spec v2 §7 agentic loop: each turn is a durable step pair
// (memoized generate → persistent-session apply/evaluate), so a crash or
// rate-limit resumes mid-loop without re-billing earlier turns. Single-shot
// tasks (max_agent_turns: 1) take the same code path — the loop degenerates
// to one pass. Green = compiled AND all tests passing (static is advisory).

type TurnTraceEntry = {
  turn: number;
  extracted: boolean;
  parseError: string | null;
  compiled: boolean | null;
  testsPassed: number | null;
  testsTotal: number | null;
  green: boolean;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  reasoningChars: number | null;
  stdoutExcerpt: string;
  stderrExcerpt: string;
};

function isGreen(r: { compiled: boolean | null; testsPassed: number | null; testsTotal: number | null }): boolean {
  return r.compiled === true && r.testsTotal !== null && r.testsTotal > 0 && r.testsPassed === r.testsTotal;
}

function serializeFiles(files: Record<string, string>): string {
  const paths = Object.keys(files).sort();
  if (paths.length === 1) return files[paths[0]];
  return paths.map((p) => `--- ${p} ---\n${files[p]}`).join("\n\n");
}

async function executeSampleBody(modelId: string, step: Step, data: unknown): Promise<Record<string, unknown>> {
  const parsed = SampleRequestedSchema.safeParse(data);
  if (!parsed.success) {
    throw new NonRetriableError(`invalid sample event: ${parsed.error.message}`);
  }
  const { runId, taskId, sample, seed } = parsed.data;
  const model = config.models.find((m) => m.id === modelId);
  if (!model) throw new NonRetriableError(`unknown model: ${modelId}`);

  const task = await step.run("load-task", () => loadTask(taskId));
  const adapter = createAdapter(model);
  const session = await openSession(
    step,
    sessionRequestForTask(
      task,
      `omt-${slugify(runId)}-${slugify(model.id)}-${slugify(task.id)}-s${sample}`,
    ),
  );

  const trace: TurnTraceEntry[] = [];
  let turnsToGreen: number | null = null;
  let lastResult: Awaited<ReturnType<SandboxSession["turn"]>> | null = null;
  let lastFiles: Record<string, string> = {};
  let lastFeedback: string | null = null;

  // Whole-loop generation metrics (the sample's cost is every turn's cost).
  let tokensPrompt = 0;
  let tokensCompletion = 0;
  let genLatencyMs = 0;
  let costUsd = 0;
  let ttftMs: number | null = null;
  let sawMetrics = false;

  for (let turn = 1; turn <= task.max_agent_turns; turn++) {
    // Memoized per turn: a retried run replays earlier turns without
    // re-billing the model.
    const gen: GenerationResult = await step.run(`turn-${turn}-generate`, () =>
      adapter.generate(
        buildGenerationRequest(task, model, config, seed, {
          turn,
          prevFiles: turn > 1 ? lastFiles : null,
          prevFeedback: turn > 1 ? lastFeedback : null,
        }),
      ),
    );
    if (gen.tokensPrompt !== null) tokensPrompt += gen.tokensPrompt;
    if (gen.tokensCompletion !== null) tokensCompletion += gen.tokensCompletion;
    if (gen.costUsd !== null) costUsd += gen.costUsd;
    genLatencyMs += gen.latencyMs;
    if (turn === 1) ttftMs = gen.ttftMs;
    if (gen.tokensPrompt !== null || gen.tokensCompletion !== null) sawMetrics = true;

    const extracted = extractFiles(gen.raw, task.entrypoint);
    let result: Awaited<ReturnType<SandboxSession["turn"]>>;
    if (Object.keys(extracted.files).length === 0) {
      // Unparseable reply counts as a failed turn — the parse error feeds
      // back into the next turn instead of failing the sample.
      result = {
        compiled: false,
        testsPassed: null,
        testsTotal: null,
        staticPass: null,
        staticIssues: null,
        stdout: "",
        stderr: extracted.parseError ?? "unparseable reply",
        durationMs: 0,
      };
      lastFiles = {};
      lastFeedback = extracted.parseError;
    } else {
      result = await session.turn(step, turn, extracted.files);
      lastFiles = extracted.files;
      lastFeedback = [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || "no output captured";
    }

    const green = isGreen(result);
    trace.push({
      turn,
      extracted: extracted.extracted,
      parseError: extracted.parseError,
      compiled: result.compiled,
      testsPassed: result.testsPassed,
      testsTotal: result.testsTotal,
      green,
      tokensPrompt: gen.tokensPrompt,
      tokensCompletion: gen.tokensCompletion,
      latencyMs: gen.latencyMs,
      costUsd: gen.costUsd,
      reasoningChars: gen.reasoningChars,
      stdoutExcerpt: result.stdout.slice(-2048),
      stderrExcerpt: result.stderr.slice(-2048),
    });
    lastResult = result;

    if (green) {
      turnsToGreen = turn;
      break;
    }
  }

  // Dump-on-close on the normal exit path only: closing inside a finally
  // would destroy the session a mid-loop retry needs to reattach to
  // (memoized turn steps don't re-write their files). A hard-failed sample
  // leaks the session to its running timeout — documented beta caveat.
  const dump = await session.close(step);

  const tokensPerSec =
    tokensCompletion > 0 && genLatencyMs > 0 ? tokensCompletion / (genLatencyMs / 1000) : null;

  const artifactsRef = `results/${runId}/artifacts/${model.id}/${task.id}/s${sample}`;
  const row = {
    run_id: runId,
    model: model.id,
    model_params: JSON.stringify({ ...model.params, model: model.model, seed }),
    task_id: task.id,
    tier: task.tier,
    task_type: task.task_type,
    language: task.language,
    sample,
    seed: seed ?? null,
    compiled: lastResult?.compiled === null || lastResult === null ? null : lastResult.compiled ? 1 : 0,
    tests_passed: lastResult?.testsPassed ?? null,
    tests_total: lastResult?.testsTotal ?? null,
    static_pass: lastResult?.staticPass === null || lastResult?.staticPass === undefined ? null : lastResult.staticPass ? 1 : 0,
    static_issues: lastResult?.staticIssues ?? null,
    turns_to_green: turnsToGreen,
    max_agent_turns: task.max_agent_turns,
    agent_turns: trace.length,
    turns_trace: JSON.stringify(trace),
    artifacts_ref: artifactsRef,
    tokens_prompt: sawMetrics ? tokensPrompt : null,
    tokens_completion: sawMetrics ? tokensCompletion : null,
    ttft_ms: ttftMs,
    tokens_per_sec: tokensPerSec,
    latency_ms: sawMetrics ? genLatencyMs : null,
    cost_usd: sawMetrics ? costUsd : null,
    judge_score: null,
    code: Object.keys(lastFiles).length > 0 ? serializeFiles(lastFiles) : gen_placeholder(trace),
    stdout: lastResult?.stdout ?? null,
    stderr: lastResult?.stderr ?? null,
    error: null,
  };

  await step.run("persist-result", () => {
    const dir = join(PROJECT_ROOT, artifactsRef);
    mkdirSync(dir, { recursive: true });
    for (const [p, c] of Object.entries(dump.files)) {
      const target = join(dir, p);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, c);
    }
    writeFileSync(join(dir, "turns.json"), JSON.stringify(trace, null, 2));
    upsertResult(row);
  });

  // Dashboard scores — durable writes, skipped while the sandbox is pending.
  if (row.compiled !== null) {
    await step.score("score-compiled", { name: "compiled", value: row.compiled === 1 });
  }
  const passRate =
    row.tests_total !== null && row.tests_total > 0 && row.tests_passed !== null
      ? row.tests_passed / row.tests_total
      : null;
  if (passRate !== null) {
    await step.score("score-test-pass-rate", { name: "test-pass-rate", value: passRate });
  }
  if (row.static_pass !== null) {
    await step.score("score-static-pass", { name: "static-pass", value: row.static_pass === 1 });
  }
  if (row.turns_to_green !== null) {
    await step.score("score-turns-to-green", { name: "turns-to-green", value: row.turns_to_green });
  }
  if (row.latency_ms !== null) {
    await step.score("score-latency-ms", { name: "latency-ms", value: row.latency_ms });
  }
  if (row.tokens_per_sec !== null) {
    await step.score("score-tokens-per-sec", { name: "tokens-per-sec", value: row.tokens_per_sec });
  }
  if (row.cost_usd !== null) {
    await step.score("score-cost-usd", { name: "cost-usd", value: row.cost_usd });
  }

  await step.sendEvent("emit-sample-completed", {
    name: EVENTS.sampleCompleted,
    data: { runId, modelId: model.id, taskId: task.id, sample },
  });

  return {
    compiled: row.compiled,
    testsPassed: row.tests_passed,
    testsTotal: row.tests_total,
    turnsToGreen,
    turns: trace.length,
    extracted: trace[trace.length - 1]?.extracted ?? false,
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
  };
}

// Placeholder when every turn failed to parse (failure-gallery readability).
function gen_placeholder(trace: TurnTraceEntry[]): string {
  return `[no parseable files in any of ${trace.length} turn(s)]`;
}

export const executeSample = inngest.createFunction(
  {
    id: "execute-sample",
    retries: 2,
    // Keyed per model: each variant keeps its own lane (provider capacity
    // for the contender, API rate limits for the baseline), independently.
    concurrency: {
      limit: Math.max(...config.models.map((m) => m.concurrency)),
      key: "event.data.modelId",
    },
    triggers: [{ event: EVENTS.sampleRequested }],
    // A permanently failed sample must still count toward the tally, or the
    // run would never complete: record a failure row and emit completion.
    onFailure: async ({ event, step }) => {
      const inner = (event.data.event?.data ?? {}) as unknown;
      const parsed = SampleRequestedSchema.safeParse(inner);
      if (!parsed.success) {
        console.error("execute-sample failure without a parseable original event", event.data.error);
        return;
      }
      const { runId, taskId, sample } = parsed.data;
      const modelId = parsed.data.modelId;
      const model = config.models.find((m) => m.id === modelId);
      const meta = await step.run("resolve-task", async () => {
        try {
          const t = loadTask(taskId);
          return { tier: t.tier, task_type: t.task_type, language: t.language, maxTurns: t.max_agent_turns };
        } catch {
          return { tier: "unknown", task_type: "coding", language: "unknown", maxTurns: 1 };
        }
      });
      await step.run("record-failure", () =>
        upsertResult({
          run_id: runId,
          model: model?.id ?? modelId,
          model_params: "{}",
          task_id: taskId,
          tier: meta.tier,
          task_type: meta.task_type,
          language: meta.language,
          sample,
          seed: null,
          compiled: null,
          tests_passed: null,
          tests_total: null,
          static_pass: null,
          static_issues: null,
          turns_to_green: null,
          max_agent_turns: meta.maxTurns,
          agent_turns: 0,
          turns_trace: null,
          artifacts_ref: null,
          tokens_prompt: null,
          tokens_completion: null,
          ttft_ms: null,
          tokens_per_sec: null,
          latency_ms: null,
          cost_usd: null,
          judge_score: null,
          code: null,
          stdout: null,
          stderr: null,
          error: event.data.error?.message ?? "unknown error",
        }),
      );
      await step.sendEvent("emit-sample-completed", {
        name: EVENTS.sampleCompleted,
        data: { runId, modelId, taskId, sample },
      });
    },
  },
  async ({ event, step, group }) => {
    const parsed = SampleRequestedSchema.safeParse(event.data ?? {});
    if (!parsed.success) {
      throw new NonRetriableError(`invalid sample event: ${parsed.error.message}`);
    }
    const modelId = parsed.data.modelId;
    const model = config.models.find((m) => m.id === modelId);
    if (!model) throw new NonRetriableError(`unknown model: ${modelId}`);

    // The faceoff: one variant per configured model, deterministic selection
    // from the event. Scores inside the variant attach to it automatically.
    const { result, variant } = await group.experiment("model-faceoff", {
      variants: Object.fromEntries(
        config.models.map((m) => [m.id, () => executeSampleBody(m.id, step, event.data)]),
      ),
      select: experiment.fixed(modelId),
    });
    return { ...result, variant };
  },
);

// -- tally-samples ------------------------------------------------------------
//
// The join back to a completed run. One function, global concurrency 1 (the
// repo's single-writer pattern from phase-3's capture-dataset): sample
// completions land serialized, the completions table is idempotent, and the
// last arrival flips the run to aggregating and emits run.completed exactly
// once. (A crash between sendEvent and the status flip can re-send
// run.completed on retry — aggregate-run is idempotent, so that's harmless.)

export const tallySamples = inngest.createFunction(
  { id: "tally-samples", concurrency: 1, triggers: [{ event: EVENTS.sampleCompleted }] },
  async ({ event, step }) => {
    const parsed = SampleCompletedSchema.safeParse(event.data ?? {});
    if (!parsed.success) {
      throw new NonRetriableError(`invalid completion event: ${parsed.error.message}`);
    }
    const { runId, modelId, taskId, sample } = parsed.data;

    const { count, expected } = await step.run("record-completion", () => {
      recordCompletion(runId, modelId, taskId, sample);
      const run = getRun(runId);
      return { count: completionCount(runId), expected: run?.expected_samples ?? 0 };
    });

    if (expected > 0 && count >= expected) {
      await step.sendEvent("emit-run-completed", {
        name: EVENTS.runCompleted,
        data: { runId },
      });
      await step.run("mark-aggregating", () => markRunStatus(runId, "aggregating"));
    }

    return { count, expected };
  },
);

// -- aggregate-run -----------------------------------------------------------

export const aggregateRun = inngest.createFunction(
  { id: "aggregate-run", retries: 3, triggers: [{ event: EVENTS.runCompleted }] },
  async ({ event, step }) => {
    const parsed = RunCompletedSchema.safeParse(event.data ?? {});
    if (!parsed.success) {
      throw new NonRetriableError(`invalid run.completed event: ${parsed.error.message}`);
    }
    const { runId } = parsed.data;

    const { rows, run } = await step.run("load-rows", () => ({
      rows: getResults(runId),
      run: getRun(runId),
    }));

    const summary = await step.run("compute-summary", () => computeSummary(runId, rows, run));

    // The public artifact: committed to the repo so every reported number
    // links to raw rows (spec §12 reproducibility).
    const outDir = await step.run("write-artifacts", () => {
      const dir = join(PROJECT_ROOT, "results", runId);
      mkdirSync(dir, { recursive: true });
      Bun.write(join(dir, "rows.json"), JSON.stringify(rows, null, 2));
      Bun.write(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
      return dir;
    });

    await step.run("mark-completed", () => markRunStatus(runId, "completed"));

    return { outDir, models: summary.models.map((m) => ({ model: m.model, passAtK: m.passAtK })) };
  },
);

export const allFunctions = [orchestrateRun, executeSample, tallySamples, aggregateRun];
