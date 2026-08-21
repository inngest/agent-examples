# open-model-test

**"If It Doesn't Compile, It Doesn't Count"** — an execution-based benchmark
harness comparing an open-weight frontier claim (MiniMax M3, served in FP8
on Nebius) against a closed frontier baseline (Claude Sonnet), orchestrated
by Inngest. Code is judged by whether it compiles and passes tests — never
by an LLM's opinion of it.

M3 publishes 59.0% on SWE-Bench Pro and 66.0% on Terminal-Bench 2.1 and
claims closed-frontier parity on coding. This harness is the check: the same
published-claims story, scored by execution only, API vs. API, across pure
coding and agentic file operations.

The contender rides Nebius Token Factory's OpenAI-compatible API; the
baseline rides OpenRouter's. Swapping either is config plus at most one
adapter path (`config/benchmark.yaml`) — that the reframe from the v2
(Qwen-local) harness was a config swap, not a rebuild, is itself a result.

## Flow

```
POST /api/run
      │ benchmark/run.requested
      ▼
┌─────────────────┐   benchmark/task.sample.requested (models × tasks × k)
│ orchestrate-run │ ─────────────┬──────────────────────────┐
└─────────────────┘              ▼                          ▼
                      ┌──────────────────────┐   ┌──────────────────────┐
                      │ execute-sample-m3    │   │ execute-sample-sonnet│  ← per-model functions:
                      │  generate (memoized) │   │  generate (memoized) │    independent concurrency
                      │  sandbox (local)     │   │  sandbox             │    caps + retries
                      │  score + persist row │   │  score + persist row │
                      └──────────┬───────────┘   └──────────┬───────────┘
        benchmark/sample.completed ────────────────────────┘
                                ▼
                     ┌─────────────────┐   benchmark/run.completed
                     │ tally-samples   │───────────────┐   (concurrency: 1 —
                     └─────────────────┘               ▼    the single-writer join)
                                          ┌────────────────────┐
                                          │ aggregate-run      │ → results/<run_id>/
                                          │ pass@k · medians · │   {rows,summary}.json
                                          │ variance · cost    │
                                          └────────────────────┘
```

Every `(model, task, sample)` is a durable Inngest run: a flaky API call
retries without re-billing (memoized `generate` step), every sample is
inspectable in the dashboard, and per-sample scores (`latency-ms`,
`tokens-per-sec`, `cost-usd`, `compiled`, `test-pass-rate`, `static-pass`)
stream to the Inngest dashboard live.

## Setup

```bash
bun install
cp .env.example .env
```

## Running for real (Inngest Cloud)

1. **Commit first.** Every run stamps its provenance: the enclosing git
   commit, a dirty flag, and a content hash of `tasks/` (any edit to any task
   changes it). A clean commit makes the stamp meaningful; a dirty run is
   flagged as such in `summary.json`.
2. **`.env`**: set `NEBIUS_API_KEY` (contender — tokenfactory.nebius.com),
   `OPENROUTER_API_KEY` (baseline), `INNGEST_EVENT_KEY`, and
   `INNGEST_SIGNING_KEY` (from app.inngest.com). **Leave `INNGEST_DEV`
   unset** — it points the client at the local dev server, which silently
   breaks cloud runs.
3. **Terminal 1 — worker** (must stay running; sandbox steps execute here):

   ```bash
   bun run start
   # wait for: Worker: connected (ACTIVE)
   curl localhost:3001/ready   # → OK
   ```

4. **Terminal 2 — trigger + poll:**

   ```bash
   bun run benchmark           # full matrix from config/benchmark.yaml
   ```

   Progress is also live in the Inngest dashboard (every sample is a
   inspectable durable run) and via `GET /runs/:runId`. If the worker dies
   mid-run, Inngest pauses its steps; restart the worker and in-flight
   samples resume from their last completed steps (memoized `generate`
   doesn't re-bill).
5. **Export** (also written automatically on completion):

   ```bash
   bun run export [runId]      # artifacts → results/<run_id>/{rows,summary}.json
   ```

Budget: the default matrix (2 models × 5 tasks × k=5 = 50 samples) runs in
roughly 45–90 min at current medians; cost depends on the pinned rate cards
(the M3 placeholder pricing must be pinned at Δ2 before real runs — see
`config/benchmark.yaml`).

## Local dev (dev server)

Same, plus `INNGEST_DEV=1` in `.env` and a third process for the dev server:

```bash
bun run inngest    # terminal 0 — Inngest Dev Server (dashboard: localhost:8288)
bun run dev        # terminal 1 — worker (Hono API + Inngest Connect)
bun run benchmark  # terminal 2
```

For iteration on the harness, the smoke matrix keeps spend tiny:

```bash
BENCHMARK_CONFIG=config/benchmark.smoke.yaml bun run dev
```

The Δ4 thinking A/A run (same M3 twice — thinking off vs on, small task
slice) has its own config:

```bash
BENCHMARK_CONFIG=config/benchmark.aa.yaml bun run benchmark
```

## Scripts

| Script | What it does |
|---|---|
| `bun run smoke:model [taskId]` | One real generation per model, no Inngest — the Δ1 gate: verifies each provider's auth, endpoint, model string, streaming metrics, thinking toggle, extraction |
| `bun run benchmark` | Triggers the full matrix (`models × tasks × k`) and polls until complete |
| `bun run export [runId]` | Re-export a run's rows/summary + console master table (read-only DB) |
| `bun run typecheck` | `tsc --noEmit` |

API: `POST /api/run` → `{ runId }`; `GET /runs` / `GET /runs/:runId` → progress.

## Repo layout

- `config/benchmark.yaml` — the matrix: models (contender via Nebius, baseline via OpenRouter), params, pinned rate-card pricing, shared prompt; `benchmark.smoke.yaml` (cheap iteration) and `benchmark.aa.yaml` (Δ4 thinking A/A)
- `tasks/<id>/` — versioned task suite: `task.yaml` + `hidden/` (never sent to models). Five tasks across three tiers: T1 single-file algorithms, T2 hidden-contract integration (pinned zod module / Go interface), T3 ambiguity-heavy spec (ExpiringLRU). Every task is validated with good/wrong/broken reference solutions through the real runner before models see it.
- `src/models/adapter.ts` — one OpenAI-format adapter over two providers (`openai_compat` → Nebius Token Factory for M3, `openrouter` → Sonnet) + the seam for future adapters (first-party MiniMax, direct Anthropic, local weights)
- `src/sandbox/runner.ts` + `src/sandbox/local.ts` + `src/sandbox/inngest.ts` — spec §8 seam behind one `SandboxResult` contract; `local` (default) and `inngest` (Sandboxes beta) runners
- `src/scoring/` — pure stats (pass@k, median/variance) + run aggregation
- `src/db.ts` — SQLite results store, one row per (model, task, sample)
- `results/<run_id>/` — committed raw rows + summary per run

## Design notes

- **Two providers, one protocol (v3 reframe).** The v2 harness routed both
  models through OpenRouter; v3 swaps the contender to MiniMax M3 on Nebius
  Token Factory's OpenAI-compatible API (`openai_compat` adapter — endpoint,
  auth, and model string are config, verified by the Δ1 smoke gate). Spec v3
  §11 sketched a direct Anthropic adapter for the baseline; keeping Sonnet
  on OpenRouter preserves single-protocol comparability and the committed
  run history — a disclosed deviation, and the identity string says so
  (`claude-sonnet-openrouter`). Adding a third contender (e.g. first-party
  MiniMax) is one more config entry via the `createAdapter` seam.
- **Why M3 doesn't ride OpenRouter (checked 2026-08-20).** OpenRouter lists
  `minimax/minimax-m3`, but its endpoint pool has no Nebius and mixes
  quantizations — fp4 (CoreWeave, ModelRun), fp8 (most), unknown (Together)
  — with dynamic routing, so samples within one run could land on different
  providers at different precisions. That uncontrolled confound is exactly
  what the pinned `minimax-m3-fp8-nebius` identity (spec v3 §10) and the
  "served by Nebius in FP8" footnote exist to prevent. One extra API key is
  the entire cost of a controlled serving claim.
- **Served precision, disclosed.** The M3 identity string encodes provider +
  precision (`minimax-m3-fp8-nebius`); every published chart footnotes
  "M3 served by Nebius in FP8". If FP8-served numbers were considered
  unrepresentative, that conversation happens before the full batch, not
  after.
- **Thinking mode.** M3 supports a thinking/reasoning toggle. It is a
  pinned, per-model config param (`thinking: true|false`) recorded in every
  result row; the Δ4 A/A run (`config/benchmark.aa.yaml`) decides it with
  data, and the pinned value is disclosed in the article. Sonnet has no
  equivalent toggle in this setup — a disclosed asymmetry, not silently
  compensated. Both models get the same `max_tokens` budget (8192) — a cap
  difference would be an unfair confound since a truncated solution fails
  the compile gate.
- **Seeds.** `seed_policy: vary` derives a deterministic seed per
  `(model, task, sample)` — retried samples reuse it. Providers honor
  `seed` only where supported (OpenRouter forwards to backing providers
  that accept it; Nebius's behavior is checked at Δ1); where unsupported,
  sampling is provider-default. Documented deviation, recorded per row.
- **Cost.** API-to-API per-token math (spec v3 §8.5): token usage × prices
  pinned from each provider's rate card at setup, with the snapshot keyed
  by model id in every run's `summary.json` (`meta.rateCard`) so committed
  numbers stay auditable if pricing changes. M3's long-context tier above
  512K input tokens never applies — the tasks are far below it. When
  OpenRouter reports a per-generation cost in the streaming usage chunk,
  that authoritative number wins for the baseline.
- **The join.** Sample completions converge on `tally-samples`
  (`concurrency: 1`, phase-3's single-writer pattern): an idempotent
  `completions` table + atomic count, so the last arrival emits
  `run.completed` exactly once. A crash between `sendEvent` and the status
  flip can re-send it — `aggregate-run` is idempotent, so that's harmless.
- **Failures still count.** A sample that exhausts retries hits an
  `onFailure` handler: it records a failure row and emits its completion, so
  a dead sample degrades the score instead of hanging the whole matrix.
- **Sandbox runners behind one contract.** `SandboxResult` is the interface;
  `sandbox.runner` config selects the implementation:
  - `inngest` — real isolation via the Inngest Sandboxes beta (experimental,
    cloud-only + access-gated): durable `step.sandbox.create/run/destroy`
    steps, file upload through the direct `inngest.sandboxes` client (the
    durable surface has no file ops), per-sample deterministic sandbox names
    so retries reattach instead of leaking VMs, destroy on every exit path.
    The fixed beta image ships Node/Python/Ruby only — Go tasks fail fast
    with a pointer to `local` (no custom images in the beta).
  - `local` (default) — host execution in an ephemeral temp dir: per-command
    timeouts, env scrubbed of secrets, hermetic per-sample Go caches, `bun
    install` per TS sample. No isolation: fine for a private benchmark over
    self-authored tasks, not for untrusted ones.
  - `stub` — all-null sandbox fields; rows stay pending.
  Gated scoring lives in the runners: compile fail → 0 and tests/static are
  skipped (null), not scored as failures.

## Reproducibility checklist

- [x] Provider + endpoint + served precision recorded for each model (Nebius Token Factory, M3 in FP8, identity `minimax-m3-fp8-nebius`; baseline via OpenRouter, identity `claude-sonnet-openrouter`) — recorded verbatim per row
- [x] Exact model strings pinned in `config/benchmark.yaml` and recorded per row — plus **run dates** in every summary (`meta.createdAt`/`completedAt`): hosted models change under you, the date is part of the identity
- [x] All generation params in the row (`model_params` includes seed + thinking setting + provider model string)
- [x] Rate-card snapshot behind every cost number (`meta.rateCard` in `summary.json`, keyed by model id)
- [x] Raw results JSON committed under `results/<run_id>/`
- [x] Task-suite version: content hash (sha256) of `tasks/` stamped into every run + summary — stronger than a git tag, it can't drift from the files that ran
- [x] Harness commit hash + dirty flag stamped into every run (null commit + `dirty: true` if run outside a repo — commit before real runs)
- [x] Provider variance caveat documented (Design notes): M3's open weights make full local reproduction possible in principle, but the published numbers are Nebius-served in FP8 — reproducers should expect provider variance
- [x] One-command reproduce (`bun install` → set `.env` (two API keys, no GPU) → `bun run start` + `bun run benchmark`)
