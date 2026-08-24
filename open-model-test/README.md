# open-model-test

**"If it doesn't compile, it doesn't count."**

An execution-based benchmark harness that compares an open-weight frontier
claim against a closed frontier baseline — currently MiniMax M3 (FP8 on
Nebius Token Factory) vs Claude Sonnet (OpenRouter) — orchestrated end-to-end
by [Inngest](https://www.inngest.com). Code is judged only by whether it
compiles and passes tests, never by an LLM's opinion of it.

Every `(model, task, sample)` unit is a durable Inngest function run: a flaky
API call retries without re-billing (the generation step is memoized), every
sample is inspectable in the dashboard, and per-sample scores (latency,
tokens/sec, cost, compile, test-pass-rate, static checks) stream to the
Inngest Experiments dashboard as they complete.

- **What we measured** → [FINDINGS.md](FINDINGS.md) (final tables + analysis)
- **Inngest Sandboxes environment notes + SDK bugs worked around** →
  [INNGEST-SANDBOX-BUGS.md](INNGEST-SANDBOX-BUGS.md)

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

Two sandboxes runners ship:

- **`local`** (default) — compiles and tests in a local scratch dir. Needs Go
  installed on your machine.
- **`inngest`** — runs compilation inside [Inngest Sandboxes](https://www.inngest.com/docs/sandboxes)
  (cloud VMs, hermetic VPC). The worker ships a pinned Go toolchain into each
  sandbox through the files API; see `src/sandbox/inngest.ts` and
  INNGEST-SANDBOX-BUGS.md for the environment constraints.

## Quickstart (local runner + Inngest Dev Server)

```bash
bun install
cp .env.example .env        # fill in NEBIUS_API_KEY and/or OPENROUTER_API_KEY
bun run inngest             # terminal 1: Inngest Dev Server (dashboard: localhost:8288)
bun run dev                 # terminal 2: the harness (port 3001)
curl -X POST localhost:3001/api/run   # fires the benchmark matrix
```

Watch runs land in the Dev Server dashboard; results persist to SQLite
(`data/results.db`) and `results/<run_id>/{rows,summary}.json`. Useful
endpoints: `GET /runs`, `GET /runs/:runId`, `GET /ready`.

Cost control on first try: point `BENCHMARK_CONFIG` at a copy of
`config/benchmark.yaml` with `k_samples: 1` and a `run.tasks` subset.

## Cloud mode (Inngest Cloud + Sandboxes)

```bash
# .env: set INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY (app.inngest.com), leave INNGEST_DEV unset
BENCHMARK_CONFIG=config/benchmark.cloud.yaml bun run start
```

Sandboxes are a cloud-only beta (access-gated; a `403 access_denied` means
asking Inngest to enable them for you). Budget note: each sample ships the
~70 MB Go toolchain to its sandbox.

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
`src/models/adapter.ts` — the v2→v3 model swap (Qwen-local → M3-on-Nebius)
was exactly that, not a rebuild.

## Tasks

Ten Go tasks under `tasks/`, each with the layout:

```
tasks/go-t1-001/
  task.yaml       # prompt, tier (T1 algorithm / T2 multi-file / T3 agentic file-ops)
  workspace/      # starting files the model sees
  hidden/         # test files injected only at scoring time — the model never sees them
```

- `bun run validate:tasks` — lint every task (hermetic imports, tests
  execute, prompt fences) without touching a model.
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
