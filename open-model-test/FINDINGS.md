# Test Findings — open-model-test

Reference notes for the article. Everything below is from verified runs, with
raw data in `results/<run_id>/`. Last updated: 2026-08-21 (Δ1–Δ5 passed —
Nebius live with corrected model string/thinking wire/metric semantics; pins
in (Sonnet dated slug, M3 $0.30/$1.20); thinking pinned **off** (Finding 20);
full matrix `2026-08-21-c2ef21` on a clean stamp: **M3 90% pass@k / 92.7%
mean pass rate vs Sonnet 100% / 100%, at 7.3% of the total spend ($0.12 vs
$1.67), 11.6% per green sample** — Finding 21. The gap is one task, one
deterministic grammar edge. Δ6 reporting remains).

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
hint, not proof, of the wire spelling Nebius uses (Δ1 verdict, Finding 16b:
the hint was wrong — Nebius ignores `reasoning: {...}`; the off-switch is
`reasoning_effort: "none"`).

### Finding 15 — v3 breaks v2's serving symmetry (article caveat, pre-registered)

v2's caveat was "both models via one router → serving conditions comparable,
but absolute latency is router-inclusive." v3 is now *asymmetric*: M3 direct
on Nebius (provider-observed), Sonnet via OpenRouter (router-inclusive).
Cross-model latency/TTFT comparisons carry different routing overheads;
`ttft_ms`/`tokens_per_sec` are labeled provider-observed, and the article
must not present cross-model latency ratios as pure model speed. v2's
tok/s-is-noise caveat (142→1,233 tok/s same model same task) almost
certainly still applies to the routed side.

### Finding 16 — Δ1: the gate earned its keep (2026-08-21, live probes on tokenfactory.nebius.com)

Four claims the spec made the smoke gate verify; three needed correction.
Every number below is from live generations (ad-hoc probe scripts + two full
`bun run smoke:model` runs); the confirmed spellings are encoded in
`src/models/adapter.ts` and re-verifiable with the smoke script.

**a) The pinned model string was wrong — auth was never the problem.**
First live call returned `404 {"detail":"The model \`MiniMax/MiniMax-M3\` does
not exist."}` — a 404, not a 401, so the key was fine and the spec's guessed
string wasn't. `GET /v1/models` (30 models): the org prefix is `MiniMaxAI`
(OpenRouter's lowercase `minimax/` spelling does not carry over). Exactly one
M3 variant is served (`MiniMaxAI/MiniMax-M3`; an older M2.5 also exists) —
no precision-variant model strings, so the `fp8` in the identity rests on
Nebius's model card, not a variant slug. Fixed in all three configs.

**b) The `thinking` body param is a silent no-op — the working off-switch is
`reasoning_effort: "none"`.** M3 on Nebius reasons **by default**, streaming
an out-of-band `reasoning_content` delta channel before any content. Probed
spellings (reasoning chars on a trivial prompt; hard-prompt re-checks in
parens):

| wire spelling | reasoning emitted |
|---|---|
| no param (default) | yes — 134 chars (5,539–6,447 on hard prompt) |
| `thinking: false` | yes — ignored, 134 chars |
| `enable_thinking: false` | yes — 53 chars |
| `chat_template_kwargs: {enable_thinking: false}` | yes — 109 chars |
| `reasoning: {enabled: false}` | yes — 147 chars |
| `reasoning: {exclude: true}` | yes — 97 chars |
| `reasoning_effort: "low"` | yes — 97 chars |
| `reasoning_effort: "none"` | **no — 0 chars, 0/4 runs** |

Finding 14's hint (OpenRouter exposes `reasoning`/`include_reasoning`) was
wrong in a useful way: Nebius accepts `reasoning: {...}` without error and
ignores it. Silent acceptance of unknown params is the trap — no 400 ever
fires, so only token-level output diffs can prove a toggle works.
`applyThinking()` now maps `thinking: false → reasoning_effort: "none"` and
`thinking: true →` omit (provider default = on), so the Δ4 A/A pair differs
by exactly one wire bit.

**c) Reasoning tokens are hidden in `reasoning_tokens` but billed in
`completion_tokens`.** The usage chunk reports `reasoning_tokens: 0` even
while thousands of reasoning chars stream — but `completion_tokens` includes
them (hard prompt: 2,184/2,374 completion with ~5.5–6.4K reasoning chars vs
714/1,013 with reasoning off). So cost math over `completion_tokens` stays
honest, and the "thinking tokens bill as output" cost caveat is now
measured, not assumed: on the same smoke task, thinking-off M3 finished at
154–206 completion tokens; default-on burned 921 — the on/off decision
(Δ4) moves the output-token basis ~4–6×.

**d) Stream-metric semantics were wrong for a reasoning model — and a burst
artifact faked 3,502 tok/s.** The adapter measured TTFT as first *content*
token and tok/s over the content phase only. With M3 streaming reasoning
first, TTFT excluded the entire thinking preamble and tok/s divided
reasoning-inclusive `completion_tokens` by a content-only window — the first
smoke run "achieved" 3,502 tok/s because 921 tokens landed in a ~260 ms
burst (short Nebius replies can arrive in a single flush). Fixed: TTFT is
first token of **any** channel; tok/s is completion tokens over the
first→last-token window; a zero-width burst window yields null rather than a
fabricated number. Non-reasoning models (Sonnet) are unaffected — its smoke
numbers barely moved (105.6 → 103.2 tok/s). `reasoningChars` is now recorded
per turn in the trace for the Δ4 A/A analysis. Post-fix smoke (same task,
thinking off): M3 TTFT 1.2 s, 96.4 tok/s, extracted `truncate.go` via
markers; Sonnet TTFT 2.0 s, 103.2 tok/s, $0.003766 (OpenRouter-reported
cost). M3 cost showed $0.000000 — the Δ2 `0.0` placeholders doing their
visibly-wrong job.

Side observation for Δ3: provider-observed TTFT on Nebius is noisy — three
identical thinking-off smoke requests measured 5.1 s / 20.3 s / 1.2 s to
first token. Same shape as v2's OpenRouter tail-latency finding (Finding 3's
186.9 s outlier): the concurrency/headroom gate should watch first-token
variance, not just throughput.

### Finding 17 — Δ2: pins are in, provenance disclosed (2026-08-21)

**a) Sonnet pinned to a dated snapshot: `anthropic/claude-sonnet-5-20260630`.**
The OpenRouter endpoints API shows all 9 backing providers (Anthropic,
Amazon Bedrock ×2, Azure ×2, Google ×3) serving exactly this dated snapshot.
The alias `anthropic/claude-sonnet-5` currently maps to it — but aliases
silently re-point when the vendor ships; a dated slug can't drift. Verified
live (the slug routes and completes). One wrinkle: the completion response
echoes the *alias* in its `model` field, so the response alone doesn't prove
which snapshot served you — the endpoints-API dump plus the run date
(spec v3 §13) are the pin's evidence. Pool pricing is mixed: $2.00/$10.00
on 6/9 endpoints, $2.20/$11.00 on 3 (Bedrock + 2× Google) — dynamic routing
over mixed prices means the per-sample price depends on the provider drawn,
which is exactly why the harness lets OpenRouter's reported per-generation
cost override config math (v2 Finding 6): the baseline's cost column stays
the billed number, not an estimate.

**b) M3 rate card pinned: $0.30/$1.20 per Mtok — from corroborated third
parties, not the primary source.** Nebius's public docs expose no per-model
pricing (the console page is login-gated; legacy `docs.nebius.com/studio/
pricing` URLs redirect to the Token Factory quickstart). The pin comes from
two independent Nebius-specific trackers (typingmind's Nebius pricing
calculator; whichllm.io's `nebius-MiniMaxAI--MiniMax-M3` page), consistent
with the first-party cluster price in Finding 14's OpenRouter pool dump.
Disclosed provenance, dated pin, snapshotted into every run's
`meta.rateCard`; the first billed run cross-checks it against the Nebius
console. Post-pin smoke (thinking off): M3 673 in / 154 out → **$0.000387**
— matches hand math exactly (673·$0.30/M + 154·$1.20/M); Sonnet $0.003766
(reported). On pinned list prices, M3 is 15% in / 12% out of Sonnet —
measured ratios wait for Δ5.

**c) Δ3 intel from the rate-limits doc (headroom probe design).** Nebius
rate limits are dynamic: rolling 15-minute buckets; ≥80% average usage →
limit ×1.2 next window, ≤50% → ÷1.5; hard ceiling 20× the base allocation;
429 on excess; `x-ratelimit-*` response headers expose remaining
requests/tokens plus the current dynamic scale factor; over-limit requests
may still process at lower priority with `x-ratelimit-over-limit: yes` (an
early warning, not an error). Defaults are account-specific (console,
login-gated). Implication: for a 50-sample matrix the binding risk is not
RPM at concurrency 4 — it's tail TTFT (Finding 16 side note). Δ3's probe
should fire parallel generations and read the headers, not guess.

### Finding 18 — Δ3: headroom confirmed behaviorally; the documented header channel isn't there (2026-08-21)

Probe: `bun run probe:nebius` (committed as the Δ3 gate script) — waves of
4/8/12 parallel streaming generations, identical tiny prompts, reasoning off.

| wave (parallel) | ok | TTFT min/med/max ms |
|---|---|---|
| 4 (= batch concurrency) | 4/4 | 1,372 / 1,372 / 1,387 |
| 8 | 8/8 | 718 / 966 / 1,229 |
| 12 | 12/12 | 676 / 1,236 / 1,631 |

- **No 429s, no over-limit warnings, at 12 parallel = 3× the configured
  batch concurrency of 4 — and TTFT did not inflate with parallelism.**
  Batch concurrency 4 is safe with ~3× demonstrated headroom; the binding
  risk for the matrix stays provider-side tail TTFT (Finding 16 side note),
  which is variance, not self-inflicted queuing. Probe cost: 24 tiny
  reasoning-off requests — fractions of a cent.
- **The `x-ratelimit-*` response headers Nebius's rate-limits doc documents
  (limits, remaining, dynamic-scale factor) are not present on Token Factory
  chat-completions responses** — the snapshot found only `x-request-id`.
  The doc's own monitoring advice (track remaining via headers, watch
  `x-ratelimit-over-limit`) can't be implemented as written; headroom had to
  be measured behaviorally. Docs-vs-reality sibling of Finding 16b's silent
  param acceptance — the Δ-gate pattern (verify the provider's claims, not
  the docs) pays again.
- TTFT in the 4-wave clustered at ~1,372–1,387 ms across all four requests,
  and later waves measured *faster* — consistent with prompt caching on the
  identical probe prompt warming between waves (Nebius bills a cache-hit
  input tier; the Δ1 smoke also showed identical-prompt variance shrinking
  across runs). Noise floor caveat: single-request TTFT has ranged
  0.68–20.3 s across all Δ1–Δ3 probes on this account — treat any one
  number as a draw, not a constant.

### Finding 19 — the A/A that couldn't: two more harness bugs, caught by spending money (2026-08-21, runs `7ce0fa`/`d45d26`)

The first Δ4 attempt scored 16/16 compile-fails and exposed **harness bug
#8: no host Go toolchain** — the machine's `go` had been removed since v2;
every sample died `bash: go: command not found`, $0.055 of model spend for a
0% that looked like a model result. Fix: `orchestrate-run` now probes host
toolchains through the same `bash -c command -v` + inherited-env path the
local runner uses, NonRetriable, before create-run/fan-out — zero spend on
a broken environment ever again.

Re-run with Go 1.27 installed: real scores, and **harness bug #9: three of
ten Go tasks were unpassable-by-omission.** `go-t1-002`, `go-t2-002`,
`go-t3-001` (the v3 suite expansion) shipped with no `hidden/go.mod` —
every sample compile-fails at "directory prefix . does not contain main
module", regardless of code quality. `go-t1-002`'s hidden test was *also*
self-contradictory: `café_réstaurant → "caf-restaurant"` requires é→e
transliteration while `l'été est arrivé → "lt-est-arriv"` (and the prompt's
own "non-ASCII runes are dropped" rule) require dropping — no deterministic
policy satisfies both. Fixed the expected value to `"caf-rstaurant"`
(dropping, per the stated rule and the test's own case 18). Fixes: seeds
added, test corrected, and the good/wrong/broken validation matrix from
Finding 11 committed as `bun run validate:tasks` (9/9 green, $0) — the step
whose absence let all of this ship. Lesson repeats, louder: *every* suite
change re-validates before budget; a scored run is an expensive test
suite validator.

### Finding 20 — Δ4 A/A verdict: thinking OFF (2026-08-21, run `2026-08-21-9658e7`)

Clean suite, both arms on the Δ1-confirmed wire spelling, 16 samples.
Provenance: commit `381a307`, `dirty: true` (the two earlier runs' results
dirs were uncommitted at start — disclosed).

| arm | pass@k | compile | median lat | median TTFT | median tok/s | median $ |
|---|---|---|---|---|---|---|
| thinking off | 50% | 50% | 10.4 s | 969 ms | 76.5 | $0.00125 |
| thinking on | 75% | 62.5% | 35.8 s | 1,000 ms | 91.4 | $0.00464 |

**Decision: `thinking: false`, pinned in `benchmark.yaml` (disclosed).**
Three reasons, in order of weight:

1. **Thinking-on systematically dies on T3: 4/4 samples across both A/A
   runs hit the full 8192-token budget with reasoning only — zero content,
   $0.00999 each, guaranteed compile-fail.** Reasoning tokens bill as
   output and consume the shared budget (Δ1 Finding 16c), and the equal
   `max_tokens` rule is experimental protocol, not an infra detail (v2
   Finding 5). Under this harness's own fairness rules, budget starvation
   *is* the failure. Raising the thinking arm's cap would break the
   protocol to rescue a mode — the exact silent compensation the spec
   forbids.
2. **3.4× latency, 3.7× cost per sample** (medians), with TTFT identical
   (~1 s — reasoning streams first but starts just as fast).
3. The capability story is mixed, not dominant: thinking-on swept T2
   integration (go-t2-001 2/2 vs 0/2 this run) but flipped go-fileops to
   1/2, and its T2 win inverted across runs (off was 1/2 in `d45d26`) —
   k=2 A/A noise, while the T3 cap-death and the cost/latency penalty were
   stable across every run. When the stable effects all point one way and
   the noisy one points the other, the stable ones decide.

Article framing: the A/A is a *mode* decision, not a capability result —
"M3 with reasoning drowned in its own thinking on the hardest tier" is a
finding about fixed-budget agentic harnesses vs. chat-bench defaults, and
belongs in the piece (SWE-Bench-style harnesses don't share this budget
protocol; Terminal-Bench-style ones do).

Per-task detail (run `9658e7`): off swept T1 2/2 and T3 2/2 (5/5 hidden
tests each, ~1,300–1,500 completion tokens — the evaluator passes without
reasoning), went 0/2 on go-t2-001 (compile-fails) and 0/2 on fileops after
4 turns; on swept T1 2/2 and both T2s, died both T3 samples at the cap.
Cross-run variance note: off's go-t2-001 passed 1/2 in `d45d26` — samples
flip run-to-run at temp 0.2 despite identical seeds (Nebius's seed support
is unverified, Finding 16), so k=5 in Δ5 is load-bearing.

### Finding 21 — Δ5 full matrix: 90% of the baseline's pass@k at 7% of the spend (2026-08-21, run `2026-08-21-c2ef21`)

The clean-stamp run: commit `5bdf732`, `gitDirty: false`, 2 models × 10
tasks × k=5 = 100 samples, thinking-off M3 (Δ4 pin) vs Sonnet dated slug.
Wall clock ~10 min (dev server, concurrency 4 per model).

| | M3 (thinking off, Nebius FP8) | Sonnet (OpenRouter) |
|---|---|---|
| pass@k (task-level) | **90%** | **100%** |
| mean test pass rate | 92.7% | 100% |
| compile rate | 76% | 92% |
| green samples | 29/50 (58%) | 46/50 (92%) |
| median latency | **3.53 s** | 5.87 s |
| median TTFT | **749 ms** | 3,975 ms |
| median tok/s | 171.6 | 90.4 |
| median $/sample | **$0.000958** | $0.006695 |
| total spend | **$0.1225** | $1.6673 |
| cost per *green* sample | **$0.0042** | $0.0362 |

**a) The parity claim doesn't quite survive — but the value claim does.**
Sonnet swept every task at k=5; M3 dropped pass@k on exactly one: go-t3-001
(0/5). Measured cost ratio: median $/sample 14.3% (list said 15%/12% —
measured ≈ list this time), cost per green sample 11.6%, total spend 7.3%.
"90% of the tasks at ~1/13th the cost per passing sample" is the honest
headline — parity no, parity-adjacent value yes.

**b) The frontier gap is one deterministic grammar edge.** M3's go-t3-001:
0/5 green, yet **5/5 samples scored exactly 4/5 tests** — every sample
built a complete recursive-descent evaluator (right-assoc `^`, unary minus,
vars, div-by-zero) and every sample failed only `TestEvalErrors`, on one
edge: `Eval("+2")` returned a value instead of an error (s0–s1), or
`Eval(".5")` did (s3–s4). One missing rejection rule, five times, at temp
0.2 with varied seeds. That is what "closed-frontier parity" looks like
under execution: not broad incompetence — the *last* error-edge of a spec
the prompt explicitly pins ("no leading '+'"). And the fix is the mode the
equal-budget protocol excluded (Finding 20): thinking-on M3 catches
exactly this class — the tension between fair-cost and fair-capability
protocols is now a data point, not a hypothetical.

**c) "Failures are the expensive samples" — replicated, and inverted.**
v2's pattern (Finding 2) industrialized by the agentic loop: Sonnet's ONE
weak task, go-fileops-t2-002, burned **$0.97 — 58% of the baseline's
entire run spend** — on 4 samples × 4 turns × ~17.5K output tokens each
(~$0.197/sample, 29× its own median), going green only once (turn 4).
M3's failures were *cheap*: its whole run, failures included, cost $0.12 —
less than one failed Sonnet sample. Cost-per-green is the metric that
matters and the expensive-failure dynamic it captures now cuts *against*
the frontier model.

**d) Latency/TTFT favor M3 — with the pre-registered caveat attached.**
M3's medians are faster on all three speed metrics, but the serving paths
are asymmetric (Finding 15): Nebius-direct vs OpenRouter-routed (Sonnet's
4.0 s TTFT is router-inclusive; v2 measured 142→1,233 tok/s router noise).
Provider-observed, not model-speed; the article must not present cross-
model latency ratios as pure model speed. Within-model ordering across
tiers is still fair game.

**e) k=5 was load-bearing (again).** M3's task-level greens span 1/5
(go-t2-001) to 5/5 (three tasks); Sonnet's single weakness is invisible in
task-level pass@k (1.0) and only shows in sample-level greenRate (0.92) and
cost. The agentic loop earned its turns for both models: 7 of M3's and 6 of
Sonnet's greens arrived after turn 1.

**f) Static checks: 100% both.** gofmt/vet pass everywhere (EOF-newline
normalization from v2 Finding 5 in effect) — formatting is a solved
problem for both model classes, and static checks no longer discriminate.

Task-level greens (M3 / Sonnet, of 5): fileops-t1 3/5·5, fileops-t2-001
2/5·5, fileops-t2-002 3/5·1, fileops-t3-001 5/5·5, fileops-t3-002 3/5·5,
go-t1-001 4/5·5, go-t1-002 3/5·5, go-t2-001 1/5·5, go-t2-002 5/5·5,
go-t3-001 0/5·5. Raw: `results/2026-08-21-c2ef21/{rows,summary}.json`.

### Cost reference points (Δ2-pinned 2026-08-21)

M3 pinned $0.30/$1.20 per Mtok (Finding 17b) vs Sonnet pinned $2.00/$10.00
(2026-08-17, re-verified 2026-08-21) — headline list ratio 15% in / 12% out.
Two v2 lessons temper that before any run: list-price arithmetic ≠ measured
cost (verbosity shifts it), and M3 is a reasoning model — thinking tokens
bill as output (Δ1-measured: ~4–6× the output-token basis with thinking on,
see Finding 16c), so the Δ4 thinking decision directly changes the cost
basis. Δ4 decided: thinking **off** (Finding 20 — the cost basis is the
thinking-off basis; the on-arm's numbers are recorded in the A/A artifacts).

### State of the gates (spec v3 §14)

Δ1 Nebius smoke — **done, 2026-08-21** (Finding 16) · Δ2 pins — **done,
2026-08-21** (Finding 17) · Δ3 headroom → concurrency — **done, 2026-08-21**
(Finding 18) · Δ4 thinking A/A — **done, 2026-08-21: thinking OFF pinned**
(Findings 19–20) · Δ5 full matrix — **done, 2026-08-21** (Finding 21: run
`2026-08-21-c2ef21`, clean stamp `5bdf732` — M3 90% pass@k / 92.7% pass
rate at 7.3% of Sonnet's total spend; the parity gap is one deterministic
T3 grammar edge) · Δ6 reporting (article drafting — everything above is
the evidence base).

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
