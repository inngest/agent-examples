# open-model-test

**"If it doesn't compile, it doesn't count."**

An execution-based benchmark harness that pits an open-weight model against a
closed frontier baseline — currently MiniMax M3 (FP8 on Nebius Token Factory)
vs Claude Sonnet (OpenRouter) — orchestrated end-to-end by
[Inngest](https://www.inngest.com). Code is judged only by whether it compiles
and passes tests, never by an LLM's opinion of it.

- **What we measured** → [FINDINGS.md](FINDINGS.md) — final tables + analysis

## What this example demonstrates

This is a complete, production-shaped Inngest application, not a toy. Reading
or running it shows:

- **Durable fan-out / fan-in** — one trigger fans out to 100+ concurrent
  per-sample function runs, then a concurrency-1 "tally" function joins them
  back into a single completed run (`src/inngest/functions.ts`).
- **Retries that don't re-bill** — each model call is a memoized
  `step.run()`, so a crashed or rate-limited run resumes without re-calling
  the provider. The generation step's result is replayed, not regenerated.
- **Agentic loops as durable steps** — every fix-loop turn is a step pair
  (memoized generate → persistent-session apply/evaluate), so a crash
  mid-loop resumes at the exact turn it died on.
- **[Inngest Experiments](https://www.inngest.com/docs/experiments)** — each
  model is a variant of a `model-faceoff` experiment; per-sample metrics
  (latency, tokens/sec, cost, compile rate, test pass rate) stream to the
  dashboard as they complete, both models side by side.
- **[Inngest Sandboxes](https://www.inngest.com/docs/sandboxes)** (closed
  beta) — optional
  cloud-only execution of untrusted model code in hermetic, egress-free VMs,
  including bootstrapping a Go toolchain through the files API.
- **Config-driven model swaps** — swapping the contender model is a YAML
  change plus at most one adapter path, not a rebuild.

## Prerequisites

- [Bun](https://bun.sh) v1.2+ (`curl -fsSL https://bun.sh/install | bash`)
- [Go](https://go.dev/dl/) 1.24+ on your PATH — the default local runner
  compiles and tests generated code on your machine
- API keys (in `.env`, see `.env.example`):
  - `NEBIUS_API_KEY` — for the MiniMax M3 contender
    ([tokenfactory.nebius.com](https://tokenfactory.nebius.com))
  - `OPENROUTER_API_KEY` — for the Claude Sonnet baseline
    ([openrouter.ai/keys](https://openrouter.ai/keys)); either key works
    alone if you trim the config to one model

**Cost of a first run:** the full matrix (2 models × 10 tasks × 5 samples)
costs roughly **$0.11 on M3 + $1.62 on Sonnet**. Run M3-only with
`k_samples: 1` for a few cents (see [Cost control](#cost-control)).

## How it works

```
POST /api/run
      │ benchmark/run.requested
      ▼
┌─────────────────┐   benchmark/task.sample.requested (models × tasks × k)
│ orchestrate-run │ ─────────────────────────────────────────────┐
└─────────────────┘                                             ▼
                    ┌───────────────────────────────────────────────┐
                    │ execute-sample                                │
                    │  ├─ group.experiment("model-faceoff") variant │
                    │  ├─ generate (memoized step — retries free)   │
                    │  ├─ sandbox: compile + go test + gofmt/vet    │
                    │  ├─ score + persist row (SQLite)              │
                    │  └─ attribute-experiment-scores               │
                    └───────────────────────────────────────────────┘
      benchmark/sample.completed (concurrency: 1 — the single-writer join)
                                 ▼
                      ┌─────────────────┐   benchmark/run.completed
                      │ tally-samples   │───────────────┐
                      └─────────────────┘               ▼
                                          ┌────────────────────┐
                                          │ aggregate-run      │ → results/<run_id>/
                                          │ pass@k · medians · │   {rows,summary}.json
                                          │ variance · cost    │
                                          └────────────────────┘
```

Every `(model, task, sample)` unit is a durable Inngest function run: a flaky
API call retries without re-billing (generation is memoized), every sample is
inspectable in the dashboard, and per-sample scores stream to the Experiments
dashboard as they complete.

Two sandbox runners ship:

- **`local`** (default) — compiles and tests in a local scratch dir with
  scrubbed env and per-command timeouts, but **no isolation**. Fine for your
  own tasks; see the trust note in `src/sandbox/local.ts`.
- **`inngest`** — runs compilation inside Inngest Sandboxes (cloud VMs,
  hermetic VPC, no egress). The worker ships a pinned Go toolchain into each
  sandbox through the files API; see `src/sandbox/inngest.ts` for the
  environment constraints.

## Quickstart (local runner + Inngest Dev Server)

Three terminals:

```bash
# 0. one-time setup
bun install
cp .env.example .env        # then fill in NEBIUS_API_KEY / OPENROUTER_API_KEY
bun run validate:tasks      # sanity-check the task suite (free, no model calls)

# 1. Inngest Dev Server — dashboard at http://localhost:8288
bun run inngest

# 2. the harness worker — connects to the Dev Server, listens on port 3001
bun run dev

# 3. fire the benchmark matrix (or: curl -X POST localhost:3001/api/run)
bun run benchmark
```

### What you should see

1. **Terminal 1** serves the Dev Server dashboard at
   <http://localhost:8288> — open it before firing the run.
2. On worker startup (terminal 2), the four functions — `orchestrate-run`,
   `execute-sample`, `tally-samples`, `aggregate-run` — sync to the Dev
   Server and appear under Functions.
3. After the trigger, `execute-sample` runs appear one per
   (model, task, sample) and stream through their turn steps. Each one is
   individually inspectable: prompts, step outputs, sandbox stdout/stderr.
4. Terminal 3 polls progress: `running: 37/100 samples`, then
   `completed` and prints `summary: results/<run_id>/summary.json`.
5. Results persist to SQLite (`data/results.db`) and to
   `results/<run_id>/{rows,summary}.json` (rows.json is the raw per-sample
   data; summary.json the per-model aggregates).

Useful endpoints on the worker: `GET /runs`, `GET /runs/:runId`, `GET /ready`.

### Cost control

Before a first full run, point `BENCHMARK_CONFIG` at a copy of
`config/benchmark.yaml` with `k_samples: 1`, one model, and a `run.tasks`
subset — a few cents instead of a couple dollars:

```yaml
run:
  k_samples: 1
  tasks: [go-t1-001, go-t2-001]
models:
  - id: minimax-m3-fp8-nebius   # drop the second model entry
    ...
```

```bash
BENCHMARK_CONFIG=config/benchmark.cheap.yaml bun run dev
```

## Cloud mode (Inngest Cloud + Sandboxes)

```bash
# .env: set INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY (app.inngest.com), leave INNGEST_DEV unset
BENCHMARK_CONFIG=config/benchmark.cloud.yaml bun run start
```

Sandboxes are a cloud-only **closed beta** — there is no public signup; a
waitlist is available by contacting Inngest. A `403 access_denied` means your
account isn't enabled yet. Budget note: each sample ships the ~70 MB Go
toolchain to its sandbox.

## Configuration

Everything model- and protocol-related lives in `config/benchmark.yaml`:

```yaml
run:
  k_samples: 5            # samples per task (pass@k + variance)
  seed_policy: vary       # deterministic per (run, model, task, sample)
models:
  - id: minimax-m3-fp8-nebius
    adapter: openai_compat
    endpoint: ${NEBIUS_BASE_URL}
    api_key_env: NEBIUS_API_KEY
    model: MiniMaxAI/MiniMax-M3
    ...
sandbox:
  runner: local           # or: inngest
```

Swapping a contender is a config change plus at most one adapter path in
`src/models/adapter.ts` — the previous contender swap (a local Qwen model →
M3-on-Nebius) was exactly that, not a rebuild.

## Tasks

Ten Go tasks under `tasks/`, each with the layout:

```
tasks/go-t1-001/
  task.yaml       # prompt, tier (T1 algorithm / T2 multi-file / T3 agentic file-ops)
  workspace/      # starting files the model sees
  hidden/         # test files injected only at scoring time — the model never sees them
```

- `bun run validate:tasks` — lint every task (hermetic imports, tests
  execute, prompt fences) without touching a model. Reference good/wrong/
  broken solutions prove each task is passable and its tests can fail.
- `bun run smoke:model` — one cheap single generation against a chosen model.

To add a task: create the directory, keep all imports stdlib-only (sandboxes
are offline), and run the validator.

## Results

- SQLite (`data/results.db`) is the source of truth; one row per
  `(run, model, task, sample)` with tokens, cost, latency, compile/test/static
  outcomes, and the git-provenance stamp of the harness that produced it.
- `results/<run_id>/summary.json` — per-model aggregates: pass@k, green rate,
  medians, spend. `rows.json` — the raw rows.
- `bun run export <runId>` — print a master table.
- The reference run checked into this repo is `results/2026-08-24-493f4f/`
  (the cloud matrix; headline numbers in FINDINGS.md). Per-sample artifacts
  (generated code, turn traces) are gitignored.

## Project layout

```
src/
  index.ts              # Hono app: POST /api/run, run inspection endpoints
  config.ts             # config/benchmark.yaml loading + validation
  tasks.ts              # task discovery + prompts
  models/adapter.ts     # OpenAI-protocol adapters (Nebius, OpenRouter)
  sandbox/local.ts      # local compile/test runner
  sandbox/inngest.ts    # Inngest Sandboxes runner (+ toolchain bootstrap)
  scoring/              # aggregation + stats (pass@k, medians, variance)
  db.ts                 # SQLite persistence
  inngest/              # client, event schemas, the four functions
scripts/
  run-benchmark.ts      # CLI trigger (same as POST /api/run)
  validate-tasks.ts     # task linter
  smoke-model.ts        # single-generation smoke test
  export-results.ts     # master table export
tasks/                  # the benchmark tasks
config/                 # benchmark.yaml (local) · benchmark.cloud.yaml (cloud)
results/                # committed reference-run summaries
```
