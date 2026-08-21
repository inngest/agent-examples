# Test Findings — open-model-test

Reference notes for the article. Everything below is from verified runs, with
raw data in `results/<run_id>/`. Last updated: 2026-08-20 (v3 reframe
shipped: contender swap to MiniMax M3 on Nebius; OpenRouter M3 pool audited;
no scored M3 runs yet — Δ1–Δ5 pending, so no M3 performance numbers exist and
none are invented below).

## v3 reframe — M3 (Nebius) vs Sonnet (2026-08-20; engineering state)

The thesis changed from "small local model punches up" (Qwen 27B) to "do
open-weight frontier claims survive a compiler?" — MiniMax M3 publishes
59.0% SWE-Bench Pro / 66.0% Terminal-Bench 2.1 and claims closed-frontier
parity; this harness scores that claim by execution only, API vs. API.

### Finding 13 — the swap was config + one adapter path, not a rebuild

The spec bet the harness architecture on this and it held. The v2→v3 delta,
verified by typecheck + config-load + function registration (2026-08-20):

| Changed | What |
|---|---|
| `src/models/adapter.ts` | one shared OpenAI-protocol implementation over two providers (`openai_compat` → Nebius Token Factory, `openrouter` → Sonnet); per-provider client cache; M3 thinking-toggle wire spelling isolated in one `applyThinking()` helper pending Δ1 |
| `src/config.ts` | adapter enum, `endpoint` (with `${ENV}` refs), `api_key_env`, `thinking` param, optional `run.tasks` subset |
| configs | `benchmark.yaml`/`smoke.yaml` model swap; new `benchmark.aa.yaml` (Δ4 A/A); M3 pricing `0.0` placeholders until Δ2 |
| scoring | `meta.rateCard` snapshot in every summary (spec §8.5) |

Unchanged: Inngest functions, DB/data model, tasks, sandbox runners, stats.
Identity strings now encode provider + precision (`minimax-m3-fp8-nebius`,
`claude-sonnet-openrouter`) and are recorded verbatim per row. Per-model
functions re-registered as `execute-sample-minimax-m3-fp8-nebius` /
`execute-sample-claude-sonnet-openrouter` with zero harness edits.

### Finding 14 — OpenRouter cannot make the pinned-precision claim (pool dump, 2026-08-20)

`GET /api/v1/models/minimax/minimax-m3/endpoints` — 12 backing providers,
**no Nebius**, mixed quantization, dynamic routing:

| provider | quant | ctx | $/Mtok in/out |
|---|---|---|---|
| CoreWeave | **fp4** | 262,144 | 0.23/0.96 |
| GMICloud | fp8 | 1,048,576 | 0.24/0.96 |
| DeepInfra | fp8 | 524,288 | 0.28/1.10 |
| AtlasCloud / Parasail / Novita / StreamLake / Venice | fp8 | up to 1,048,576 | 0.30/1.20 |
| Together | **unknown** | 524,288 | 0.30/1.20 |
| Minimax (first-party) | fp8 | 524,288 | 0.30/1.20 |
| ModelRun | **fp4** | 1,048,576 | 0.75/3.00 |

Default routing would let samples *within one run* land on different
providers at different precisions — an uncontrolled confound inside the
contender's own numbers, and fatal to the `minimax-m3-fp8-nebius` identity
and the "served by Nebius in FP8" footnote. Hence: contender rides Nebius
direct (spec-faithful), baseline stays on OpenRouter. One extra API key is
the entire cost of a controlled serving claim.

Two side observations: (a) a first-party MiniMax endpoint sits in the pool
at the standard $0.30/$1.20 — open decision #4 (first-party footnote run)
could use it via OpenRouter provider-pinning or direct; (b) the OpenRouter
endpoints expose the toggle as `reasoning`/`include_reasoning` params — a
hint, not proof, of the wire spelling Nebius uses (Δ1 confirms).

### Finding 15 — v3 breaks v2's serving symmetry (article caveat, pre-registered)

v2's caveat was "both models via one router → serving conditions comparable,
but absolute latency is router-inclusive." v3 is now *asymmetric*: M3 direct
on Nebius (provider-observed), Sonnet via OpenRouter (router-inclusive).
Cross-model latency/TTFT comparisons carry different routing overheads;
`ttft_ms`/`tokens_per_sec` are labeled provider-observed, and the article
must not present cross-model latency ratios as pure model speed. v2's
tok/s-is-noise caveat (142→1,233 tok/s same model same task) almost
certainly still applies to the routed side.

### Cost reference points (pending pins)

M3 cluster price $0.30/$1.20 per Mtok vs Sonnet pinned $2.00/$10.00
(2026-08-17) — headline list ratio 15% in / 12% out. Two v2 lessons temper
that before any run: list-price arithmetic ≠ measured cost (verbosity
shifts it), and M3 is a reasoning model — thinking tokens bill as output,
so the Δ4 thinking decision directly changes the cost basis. Open decision:
thinking off = fairer cost/latency, on = fairer capability; A/A run decides,
decision disclosed.

### State of the gates (spec v3 §14)

Δ1 Nebius smoke (auth, `MiniMax/MiniMax-M3` string confirmation, streaming,
thinking wire) — **pending, needs `NEBIUS_API_KEY`** · Δ2 pin Sonnet slug +
rate cards over `0.0` placeholders · Δ3 Nebius headroom → concurrency · Δ4
thinking A/A (`benchmark.aa.yaml`) · Δ5 full matrix · Δ6 reporting.

## M4/M5 — T2/T3 suite + tier breakdowns

The M1 finding was that T1 saturates: both model classes pass everything, so
the benchmark can't discriminate. Three new tasks target that — a hidden
contract module the solution must integrate with without seeing (ts-t2-001,
pinned zod 3.25.76), a hidden Go interface with sentinel-error semantics
(go-t2-001), and a spec-ambiguous-by-design LRU+TTL cache with injectable
clock and cumulative stats (ts-t3-001). Aggregation grew the per-tier
`meanPassRate` that M1 had stubbed as null.

### Run `2026-08-17-60afa0` (2 models × 5 tasks × k=2 = 20 samples)

| model | pass@k | pass rate | compile | median ms | $/sample |
|---|---|---|---|---|---|
| qwen-3.8-27b | 100% | 100% | 90% | 35.5 s | $0.0052 |
| sonnet | 100% | 100% | 100% | 8.0 s | $0.0094 |

Per-tier pass@k (both models): T1 100%, T2 100%, T3 100% — but qwen's T3
cost one compile failure:

| model | task | s | result | latency | $ |
|---|---|---|---|---|---|
| qwen | ts-t3-001 | 0 | **COMPILE-FAIL** | 43.0s | $0.0147 |
| qwen | ts-t3-001 | 1 | 19/19, static ok | 51.0s | $0.0143 |
| sonnet | ts-t3-001 | 0/1 | 19/19, static ok | 29.0s / 36.4s | $0.0359 / $0.0457 |

Findings:

9. **The failure moved to the top tier, as designed.** With T1/T2 saturated
   at k=2, the only correctness gap in the matrix is qwen's T3 compile fail —
   the difficulty gradient now does work. T3's spec pins ~15 ambiguity
   resolutions (peek-vs-get recency, lazy-vs-eager expiry, expired-key
   delete semantics, stats snapshot independence); a solution survives by
   following the spec exactly, which is where a 27B model thins out.
10. **"Expensive failures" replicates on T3.** qwen's compile-fail burned
    $0.0147 — its costliest sample in the run and 5× its T2 samples. The M1
    pattern (failures are the expensive samples) is not a one-off.
11. **Harness bug #7 — found by validation, not by models.** The reference
    Go "broken" variant (constructor renamed) *passed* `go build ./...`:
    Go's build gate doesn't compile `_test.go` files, so a solution that
    breaks the test build scored `compiled=true, tests=null`. Fix: the build
    gate is now `go build ./... && go test -run '^$' -count=1 ./...`
    (compile package + test binaries, run nothing). Lesson: validate tasks
    with known-bad solutions *before* spending model budget — the 9-case
    validation matrix (good/wrong/broken × 3 tasks) cost $0 and caught what
    3 scored runs hadn't.
12. **Behavioral specs beat message-text assertions.** The zod task's hidden
    tests assert issue `code`s (`invalid_type`, `too_small`, ...) and
    dot-joined paths — verified empirically against the pinned zod version
    before baking in, never free-text error messages (which drift across
    library versions and would make the task unpassable-by-change rather
    than unpassable-by-ability). One deliberate trap: zod emits issues in
    schema order (`timeoutMs` before `tags`), but `"tags.0"` sorts before
    `"timeoutMs"` lexicographically — a solution that skips the sort fails
    exactly one test.

### M1 — first execution-scored runs (local runner)

The sandbox now executes for real: host execution in an ephemeral dir
(`sandbox.runner: local`), same `SandboxResult` contract the future Inngest
sandbox will implement — config swap, no harness changes.

### Run `2026-08-17-a9a982` (2 models × 2 tasks × k=2, real compile/test/static)

| model | pass@k | pass rate | compile | median latency | median $/sample |
|---|---|---|---|---|---|
| qwen-3.8-27b | 50% | 97% | 75% | 40.0 s | $0.0047 |
| sonnet | **100%** | **100%** | **100%** | 15.1 s | $0.0158 |

Per-sample:

| model | task | s | result | tokens | latency | $ |
|---|---|---|---|---|---|---|
| qwen | go | 0 | 6/6, static ok | 644 | 35.2s | $0.0021 |
| qwen | go | 1 | 6/6, static ok | 752 | 34.2s | $0.0025 |
| qwen | ts | 0 | **COMPILE-FAIL** | 6,223 | 142.3s | $0.0188 |
| qwen | ts | 1 | **9/10**, static ok | 2,139 | 44.9s | $0.0070 |
| sonnet | go | 0 | 6/6, static ok | 265 | 4.0s | $0.0031 |
| sonnet | go | 1 | 6/6, static ok | 262 | 3.9s | $0.0031 |
| sonnet | ts | 0 | 10/10 | 4,341 | 43.7s | $0.0441 |
| sonnet | ts | 1 | 10/10 | 2,773 | 26.2s | $0.0284 |

(A prior run, `2026-08-17-3e3e39`, scored both models 100% pass@k before the
gofmt-newline normalization — k=2 T1 is small enough that run-to-run variance
flips outcomes. That's the point of k-sampling.)

### Findings

1. **The 27B model is at the reliability edge even on T1 TypeScript.** Its
   compile failure is anatomically interesting: the solution was *correct in
   logic* but omitted the `export` keyword — `function parseDuration(...)` —
   so the hidden test's `import { parseDuration } from "./solution"` failed
   to resolve. In an opinion-judged benchmark this would score near-perfect;
   executed, it scores zero. "If it doesn't compile, it doesn't count" has
   teeth.
2. **Failures are the expensive samples.** That same compile-fail burned
   6,223 output tokens over 142.3 s and cost $0.0188 — 4× its successful
   sibling ($0.0070). The model over-produced (reasoning + long regex-heavy
   solution) and still broke the module contract. Cost-per-*passing*-sample
   is the metric that matters; raw $/sample flatters unreliable models.
3. **9/10 near-miss:** qwen's other TS sample failed exactly one hidden test
   (an edge case in the comma/separator grammar). Execution-based scoring
   catches exactly which rule broke — graders see the failing assertion.
4. **Go: both models 6/6, every run.** With one file, stdlib-only, and a
   tight spec, T1 Go is saturated at both model classes — the discriminating
   tasks for the suite are T2/T3 (multi-file, dependency-having).
5. **gofmt is a byte-level trap for LLMs.** Before normalization, *all* Go
   samples — Sonnet included — failed `gofmt -l` solely on a **missing
   trailing newline at EOF**. The code was otherwise gofmt-perfect. The
   runner now normalizes the EOF newline (a serialization quirk, not a
   code-quality signal); genuine formatting deviations still fail.
6. **Harness bugs found by executing for real** (each is a "why N=1 vibes
   checks lie" data point):
   - `typescript@5.8.0` was pinned in a task but **never shipped as stable**
     (5.8.2/5.8.3 only) — `bun install` failed every TS sample.
   - `tsc --noEmit solution.ts` auto-includes `@types/*` from node_modules
     under default ES5 lib — vitest's `@types/chai` failed to compile.
     Fix: hidden `tsconfig.json` (`skipLibCheck`, `types: []`, ES2022) +
     `tsc -p`.
   - `npx eslint` with no local install ad-hoc-fetches an **unpinned eslint
     from the network** — a reproducibility hole. Fix: eslint +
     typescript-eslint pinned in the task's hidden package.json.
   - vitest's JSON reporter prints failure stacks *before* the JSON blob;
     a 16KB output cap truncated the payload. Fix: parse raw output, and
     have vitest write `--outputFile=.test-results.json` instead.
   - A hardcoded sandbox PATH dropped the user's node (volta) —
     `env: node: No such file or directory`. Fix: inherit PATH, scrub
     secret-bearing env vars (`*_KEY|*_TOKEN|OPENROUTER_*|INNGEST_*`).

### Local-runner trust model (documented deviation)

`sandbox.runner: local` runs model output on the host: ephemeral dir,
per-command timeout, trimmed env, no network restrictions, **no isolation**.
Acceptable for a private benchmark over self-authored tasks; the Inngest
sandbox (`sandboxMiddleware` already wired) replaces it behind the same
interface when it ships.

### Inngest Sandboxes runner added (`sandbox.runner: inngest`)

Implemented against the beta docs; **not yet exercised live** — the beta is
cloud-only and access-gated (403 `access_denied` until Inngest enables the
environment), and local dev has no sandbox endpoint. Notes for when it's
enabled:

- SDK 4.18.1 ships the full typed surface (`sandboxMiddleware`,
  `step.sandbox`, `inngest.sandboxes`) matching the docs.
- **File ops are direct-client only**: the durable `step.sandbox` surface has
  no `files` — the runner creates durably via `step.sandbox.create`, then
  attaches with `inngest.sandboxes.get(id)` to upload hidden files (wrapped
  in one memoized `step.run`, safe because identical uploads are idempotent).
- **Deterministic sandbox names** (`omt-<run>-<model>-<task>-s<n>`) exploit
  active-lifetime create idempotency: a retried sample reattaches to the same
  VM instead of leaking a new one. Crash-path leaks (destroy never reached)
  remain a documented beta caveat.
- **The fixed image has no Go toolchain** (Node/Python/Ruby only; no bun, no
  custom images in beta): Go tasks fail fast with a NonRetriableError pointing
  at `runner: local`. TS installs run on `npm install` (not bun), cold cache
  per sandbox — 180s budget vs the task's 60s.
- Other mapped caveats: `step.sandbox` output cap is 2 MiB (vitest results go
  to a file + downloaded via the direct client, sidestepping truncation);
  commands are argument arrays (`/bin/sh -c` for task.yaml's shell strings);
  SandboxErrors escape untouched so Inngest owns retry vs. non-retryable
  (`operation_ambiguous` must never auto-reexec).
- Structural regression verified (`2026-08-17-a8871d`, local runner through
  the new top-level dispatch): 8/8, pass@k 100% both models.

What this enables once enabled: the same `SandboxResult` contract, real
isolation (egress-only VPC, ephemeral VM), zero harness changes — flip
`sandbox.runner: inngest` and delete the local trust-model caveat for TS.

## The verified run

- **Run ID:** `2026-08-17-733409` (smoke matrix: 2 models × 2 tasks × k=2 = 8 samples, all 8 completed)
- **Models:** `qwen/qwen3.8-27b` (temp 0.2, top_p 0.95, max_tokens 8192, reasoning_effort `low`) vs `anthropic/claude-sonnet-5` (temp 0.2, top_p 0.95, max_tokens 8192 — see "parity fix" below; this run was executed before that fix, sonnet was still capped at 4096)
- **Tasks:** `ts-t1-001` (TypeScript), `go-t1-001` (Go) — both T1 single-file algorithm tasks
- **Serving:** both via OpenRouter's OpenAI-compatible API
- **Sandbox:** stubbed — no compile/test scores yet, so no pass@k in this run. Cost and latency metrics are fully real.

## Headline numbers

| Metric (median per sample) | Qwen 3.8 27B | Sonnet | Ratio |
|---|---|---|---|
| Cost | **$0.00474** | $0.01706 | Qwen = 27.8% of Sonnet |
| Latency | 41,949 ms | **17,911 ms** | Sonnet 2.34× faster |
| TTFT | 39,091 ms | **2,337 ms** | Sonnet ~16.7× faster |
| Tokens/sec | 212.9 | 128.1 | noisy — see caveats |
| Total run cost (8 samples) | $0.0191 | $0.0785 | |

The cost thesis survives its first contact with real data: **Qwen delivered
samples at roughly a quarter of Sonnet's price.** The latency thesis is more
task-dependent than expected (below).

## Per-sample detail (rows.json, verbatim)

| Model | Task | s | prompt tok | compl tok | TTFT ms | latency ms | tok/s | cost |
|---|---|---|---|---|---|---|---|---|
| qwen | go | 0 | 197 | 610 | 25,986 | 30,267 | 142 | $0.00204 |
| qwen | go | 1 | 197 | 631 | 31,351 | 35,059 | 170 | $0.00211 |
| qwen | ts | 0 | 282 | 2,266 | **186,856** | **195,720** | 256 | $0.00738 |
| qwen | ts | 1 | 282 | 2,478 | 46,831 | 48,840 | 1,233 | $0.00755 |
| sonnet | go | 0 | 229 | 228 | 1,570 | 3,577 | 114 | $0.00274 |
| sonnet | go | 1 | 229 | 265 | 2,337 | 4,405 | 128 | $0.00311 |
| sonnet | ts | 0 | 340 | **4,096** | null | 44,377 | null | $0.04164 |
| sonnet | ts | 1 | 340 | 3,034 | 29,160 | 31,416 | 1,345 | $0.03102 |

## Observations worth writing about

### 1. The cost gap is real and larger than headline pricing suggests
List prices say Qwen 27B is ~22% of Sonnet's input price ($0.45 vs $2.00/Mtok)
and 32% of output ($3.20 vs $10/Mtok). Measured median per-sample cost came out
at **27.8%** — consistent with pricing. But per-task spread matters: on the Go
task Qwen was actually *cheaper by less* ($0.0021 vs $0.0029, 69%) because it
wrote ~2.4× more tokens (610 vs 228). Open-weight verbosity eats some of the
price advantage; the TS task is where the gap opens ($0.0075 vs $0.031–0.042).

### 2. Latency is task-bimodal for both models
- Go task: Sonnet 3.6–4.4 s total; Qwen 30–35 s. ~8× gap.
- TS task: Sonnet 31–44 s; Qwen 49 s (excluding one outlier). ~1.3× gap.

Short answers favor Sonnet's low TTFT (1.6–2.3 s vs Qwen's 26–31 s even at
`reasoning_effort: low`). Long answers are bounded by streaming throughput,
where the gap nearly disappears. **The "open models are slow" story is really a
"short-task TTFT" story** — on longer generations both models stream at
comparable wall-clock.

### 3. Tail latency is the open-model tax nobody prices in
`qwen/ts-t1-001/s0`: TTFT 186.9 s, total 195.7 s — 4× its sibling sample with
identical params, likely OpenRouter routing/failover rather than the model
itself. A benchmark that runs N=1 "vibes checks" would have recorded either
this outlier or missed it entirely. This is the argument for k-sample runs
with variance reporting.

### 4. Hybrid reasoning models silently burn the budget (harness bug #1)
`qwen3.8-27b` is a hybrid reasoning model. With default settings it spent the
*entire* token budget on internal thinking and returned **empty content** —
no error, no partial code, just `content: ""` with the tokens billed. Fix:
explicit `reasoning_effort: low` + a real budget (8192). The effort level is
now a pinned, per-row config param. Any benchmark of reasoning models that
doesn't control effort level is measuring the model's mood, not its ability.

### 5. Token-cap parity is a fairness confound (harness bug #2)
`sonnet/ts-t1-001/s0` completed at **exactly 4,096 tokens** — it hit the cap
and was truncated. In an execution-based benchmark a truncated solution fails
the compile gate, so an unequal cap quietly rigs the score. Fix: both models
now get identical `max_tokens: 8192`. Lesson for the article: *generation
budgets are part of the experimental protocol, not an infra detail.*

### 6. Measured cost beats list-price arithmetic
OpenRouter returns an authoritative per-generation `cost` in the streaming
usage chunk. When present it overrides config-pinned price math (ours was
within rounding anyway). Pricing tables drift; the billed number doesn't.

### 7. bun:sqlite named parameters fail silently (harness bug #3)
The first e2e run crashed every sample with `NOT NULL constraint failed:
results.run_id` — bun:sqlite did not bind `$`-prefixed named params passed as
a spread object; they arrived as SQL `NULL`. The unit checks passed because
they never exercised the binding path. Fix: positional params. Lesson: e2e
runs catch what unit tests structurally can't.

### 8. "Pending" scores must not erase real data (harness bug #4)
First aggregation dropped *all* metrics for sandbox-pending samples, nuking
latency/cost columns that don't depend on the sandbox. The cost/latency half
of the thesis has to survive even while compile/test scoring is pending. Fix:
cost/perf metrics accrue per-generation; correctness metrics accrue per-scored-
sample.

## Known caveats (state of the evidence)

1. **No pass@k yet** — sandbox runner is stubbed; compile/test/static columns
   are null. All correctness claims wait on M1.
2. **k=2, one task each of TS/Go** — medians over 4 samples per model;
   directionally useful, not statistically strong.
3. **OpenRouter quant opacity** — serving-side quantization for
   `qwen/qwen3.8-27b` is not disclosed, so "27B at 4-bit on one GPU" is not
   verifiable from this run. The `createAdapter` seam exists for the pinned
   local-vLLM comparison (v1.1).
4. **Seed pass-through** — `seed` is sent per sample but only honored by
   providers that support it; recorded per row, not guaranteed.
5. **tokens/sec and one TTFT are router-confounded** — throughput varies
   142→1,233 tok/s for the same model on the same task; the capped Sonnet
   sample has null TTFT/tps. Treat tok/s as noise unless measured against a
   dedicated endpoint.
6. **Both models via one router** — serving conditions are *comparable*
   between contenders (same API, same queueing), but absolute latency
   includes OpenRouter overhead. The 16.7× TTFT gap is router-inclusive.

## Smoke-test notes (pre-benchmark, single generations)

- Sonnet produced a 36-line TypeScript solution; Qwen a 30-line Go solution;
  both passed fence extraction and manual inspection. No automated scoring
  existed yet.
- Qwen's first attempt *without* `reasoning_effort` returned empty content
  (see #4) — discovered here, fixed before the real run.

## Reproduce

```bash
bun install && cp .env.example .env   # + OPENROUTER_API_KEY, NEBIUS_API_KEY, INNGEST_DEV=1
bun run inngest                       # terminal 1
BENCHMARK_CONFIG=config/benchmark.smoke.yaml bun run dev   # terminal 2
bun run benchmark                     # terminal 3
bun run export <runId>                # master table
```

Raw data: `results/2026-08-17-733409/{rows,summary}.json`. (v3 note: the
sections above describe v2 runs — Qwen contender, both models via
OpenRouter. v3 M3-on-Nebius runs land under their own run ids once Δ1+ fire.)
