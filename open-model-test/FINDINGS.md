# Test Findings — open-model-test

Final results from the two verified runs of the v3 harness: MiniMax M3
(thinking off, FP8 on Nebius Token Factory) vs Claude Sonnet (OpenRouter),
scored by execution only — compile, tests, static checks; never an LLM's
opinion. Raw data for the reference run: `results/2026-08-24-493f4f/`.

Protocol pins: identical generation budgets (max_tokens 8192, temp 0.2,
top_p 0.95), M3 thinking OFF (decided by an A/A run — thinking tokens bill
as output and the equal-cost protocol requires the thinking-off basis),
seeds varied per sample, k=5 samples per task. Pricing pinned at M3
$0.30/$1.20 vs Sonnet $2.00/$10.00 per Mtok (in/out).

## The runs

- **Local matrix (2026-08-21, run `2026-08-21-c2ef21`)** — 2 models × 10
  Go tasks × k=5 = 100 samples, clean git stamp `5bdf732`, ~10 min wall
  clock. Established the headline result.
- **Cloud matrix (2026-08-24, run `2026-08-24-493f4f`)** — same protocol,
  all execution moved into Inngest Sandboxes (hermetic cloud VMs; Go
  toolchain shipped per-sandbox through the files API). The reference run
  kept in this repo. A mid-run compute-pool exhaustion (39/100 samples
  failed at sandbox-create, before any model spend) was recovered by
  durable replay — the same run ID completed with merged history at zero
  additional model cost.

## Final numbers (cloud run, post-replay, 100/100)

| | M3 (thinking off, Nebius FP8) | Sonnet (OpenRouter) | local run ref |
|---|---|---|---|
| pass@k (task-level) | **1.00** | 1.00 | M3 0.90 / Sonnet 1.00 |
| green samples | 35/50 (70%) | 46/50 (92%) | 29/50 / 46/50 |
| compile rate | 0.88 | 0.92 | 0.76 / 0.92 |
| mean test pass rate | 0.921 | 1.000 | 0.927 / 1.000 |
| total spend | **$0.1113** | $1.6231 | $0.1225 / $1.6673 |
| median $/sample | $0.000849 | $0.006167 | $0.000958 / $0.006695 |
| cost per green sample | **$0.0032 (9.0%)** | $0.0353 | $0.0042 / $0.0362 |
| median latency / TTFT | 6.8 s / 0.99 s | 6.0 s / 2.54 s | 3.5 s / 5.9 s |

Per-task greens (M3 / Sonnet, of 5): fileops-t1-001 4/5·5, fileops-t2-001
5/5·5, fileops-t2-002 1/5·1, fileops-t3-001 5/5·5, fileops-t3-002 5/5·5,
go-t1-001 5/5·5, go-t1-002 2/5·5, go-t2-001 2/5·5, go-t2-002 5/5·5,
go-t3-001 1/5·5.

## What the numbers say

**a) The parity claim doesn't quite survive — but the value claim does.**
M3 delivers ~90% of the baseline's task coverage at ~7% of the total spend
and ~9% of the cost per passing sample. "Parity-adjacent value" is the
honest headline.

**b) The frontier gap is one deterministic grammar edge.** M3's weak task
(go-t3-001, a recursive-descent expression evaluator) went 0/5 locally and
1/5 in the cloud run: 1-for-15 across runs. Every failing sample built a
complete evaluator and missed exactly one rejection rule (`Eval("+2")` or
`Eval(".5")` returning a value instead of an error) — one missing edge
case, repeatedly, at temp 0.2 with varied seeds. Not broad incompetence:
the *last* error-edge of a spec the prompt explicitly pins.

**c) Failures are the expensive samples — and that cuts against the
frontier model.** Sonnet's one weak task (fileops-t2-002, 1/5 in both
runs) burned $0.97 — 58% of the baseline's entire local-run spend — on
agentic retries before its single green. M3's failures were cheap: its
whole run, failures included, cost less than one failed Sonnet sample.
Cost-per-green is the metric that captures this.

**d) Latency numbers are provider-observed, not model speed.** The serving
paths are asymmetric (Nebius-direct vs OpenRouter-routed; router noise of
142→1,233 tok/s was observed on the same model+task in v2). Cross-model
latency ratios must not be presented as pure model speed.

**e) k=5 was load-bearing.** Task-level pass@k hides Sonnet's weakness
entirely (1.0 despite 46/50 greens); sample-level green rate and cost
expose it. The agentic loop earned its turns: 7 of M3's and 6 of Sonnet's
greens arrived after turn 1.

**f) Static checks no longer discriminate.** gofmt/vet passed on 100% of
samples for both models — formatting is a solved problem for this class.

## Known caveats

1. k=5 × 10 tasks is directional, not statistically strong; cross-run
   green variance (M3 29→35) shows the noise floor at temp 0.2 with
   provider-side sampling nondeterminism.
2. Serving asymmetry (d above); seed is requested per sample but only
   honored by providers that support it — recorded per row, not guaranteed.
3. Sandboxes cap `runningTimeout` at 300 s — the longest task
   (fileops-t2-002) occasionally hits it mid-loop; those samples score as
   failures of the environment, not the model, and are visible as such in
   the run's error rows.
4. Post-replay churn is real: auto-retries racing replay re-sends can
   produce duplicate in-flight attempts, and last-writer-wins result
   upserts mean a late-failing attempt can clobber its sibling's completed
   row. In the reference run this was repaired from the platform's own
   recorded function results (one-off tooling, since removed from the
   repo). Harness lesson: duplicate attempts + upsert need attempt-scoped
   versioning.

## Harness/engineering notes

- The v2→v3 model swap (Qwen-local → M3-on-Nebius) was a config change
  plus one adapter path (`src/models/adapter.ts`), not a rebuild — the
  architecture bet held.
- Hybrid reasoning models silently burn budgets: M3 with default settings
  spent the *entire* token budget on thinking and returned empty content —
  no error, tokens billed. Effort/thinking toggles are pinned protocol
  parameters, not infra details.
- Generation budgets are protocol: an unequal max_tokens quietly rigs an
  execution-based benchmark (a truncated solution fails the compile gate).
- Prefer the provider's billed cost over list-price arithmetic when the
  API returns it; pricing tables drift.
- Inngest Sandboxes environment facts and the four SDK bugs worked around
  (empty-stream exec throws, upload throw-after-success, misleading
  cwd-400s, and `step.score()` not attributing experiment variants) are
  documented in `INNGEST-SANDBOX-BUGS.md`.

## Reproduce

```bash
bun install && cp .env.example .env      # + API keys
bun run inngest                          # terminal 1: Inngest Dev Server
bun run dev                              # terminal 2: the harness
bun run benchmark                        # terminal 3: fires the matrix
bun run export <runId>                   # master table from SQLite
```

Cloud mode (Inngest Sandboxes, requires cloud keys + beta access):
`BENCHMARK_CONFIG=config/benchmark.cloud.yaml bun run start`. For a cheap
first run, point `BENCHMARK_CONFIG` at a config with `k_samples: 1` and a
`run.tasks` subset.
