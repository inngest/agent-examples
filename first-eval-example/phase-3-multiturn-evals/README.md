# Phase 3 — Support-ticket triage + a richer score catalog

A multiturn support-ticket triage bot: every user turn is a customer support
ticket, and every assistant reply is a strict JSON object —
`{category, urgency, sentiment, suggested_reply}` — rather than free-text
chat. The client sends the full conversation transcript on every request, and
each triage reply is scored as its own [Inngest](https://www.inngest.com)
function run, tied back together by a shared `conversationId`. Phase 2's
single human 👍/👎 score is joined by five more from an **LLM-as-judge**
deferred scorer and two inline heuristics computed at function-body level —
eight scores total per reply, all visible on the run trace and aggregating in
the function dashboard.

The golden dataset this app captures (see **Golden dataset** below) is meant
as a fine-tune demo dataset: a small model can learn this JSON output
*format/behavior* reliably from a modest sample of a few hundred examples,
even without a system prompt at inference time. The before/after story is the
`valid-json` score jumping from roughly 50-70% (a general-purpose model
following a system-prompt instruction, which it sometimes ignores or wraps in
markdown) to close to 100% once that behavior is baked into the fine-tuned
model's weights. See **The fine-tune demo** below for the concrete steps.

This app registers as its own Inngest app —
`first-eval-example-phase-3` — distinct from phase 2's
`first-eval-example`, so it shows up as a separate app in the Inngest
dashboard (Dev Server locally, or app.inngest.com against Cloud) rather than
sharing history with phase 2.

The worker uses [Inngest Connect](https://www.inngest.com/docs/setup/connect):
an outbound persistent WebSocket to Inngest, so there's **no `/api/inngest`
serve endpoint**. Functions auto-sync when the worker connects, and long-running
steps (like the feedback scorer's 1-day `waitForEvent`) aren't bound by HTTP
timeouts.

## Multiturn ticket handling

The UI keeps a `conversationId` in state: `null` until the first reply, then
whatever the server returned, reused for every subsequent turn. On each send,
the client builds the request from the *entire visible transcript* — every
prior non-error message mapped to `{role, content}`, plus the new user
message — and posts `{ messages, conversationId }` to `/api/chat`.

Each new user turn can either add detail to the same ticket (an escalation,
extra repro steps, a correction) or be read as a follow-up on an already-open
one — there's no separate "new ticket" signal, the model has to infer it from
the transcript. `TRIAGE_SYSTEM_PROMPT` (`src/triage.ts`) explicitly instructs
the model to **re-triage the whole ticket using all context so far on every
turn**, not just react to the latest message — urgency and category can
change as new information arrives (e.g. "just me" becomes "my whole team, we
have a demo in an hour", or a "how-to" question turns out to be a "bug").

The server treats `messages` as the full conversation for that model call:
there's no server-side conversation state, so each `record-message` run is
still a single, independently durable, independently scored unit of work —
`conversationId` only exists so a dashboard query can group a set of runs
back into one conversation. This is also why the LLM judge is told to score
**context-awareness**: did the re-triage correctly account for information
revealed in earlier turns, like an escalation or category change — scored 1
when there's no earlier context to account for (a single-turn ticket).

## Score catalog

| Score | Source | Type | Meaning |
|---|---|---|---|
| `valid-json` | Inline heuristic, function-body level | number (0 or 1) | Does the reply parse as strict triage JSON (`parseTriage()`, `src/triage.ts`)? This is the headline fine-tune metric. |
| `latency-ms` | Inline heuristic, function-body level | number (ms) | Wall-clock time of the model call that produced the reply. |
| `thumbs-up` | Human feedback — deferred `createScorer` + `step.waitForEvent()` | number (0 or 1) | The user clicked 👍 (1) or 👎 (0) on that reply. No click within the timeout records nothing. |
| `category-correct` | LLM judge — deferred `createDefer` + `inngest.score.experiment()` fan-out | number (0 or 1) | Is `category` correct for the ticket described in the conversation? |
| `urgency-correct` | LLM judge (same fan-out) | number (0 or 1) | Is `urgency` correct given the ticket's real severity/impact? |
| `sentiment-correct` | LLM judge (same fan-out) | number (0 or 1) | Is `sentiment` a fair read of the customer's tone? Recorded for visibility but not part of the golden gate — see **Golden dataset**. |
| `reply-quality` | LLM judge (same fan-out) | number, 0–1 | Is `suggested_reply` short, empathetic, and appropriate for a customer to actually read? |
| `context-awareness` | LLM judge (same fan-out) | number, 0–1 | For multiturn tickets: did the re-triage correctly account for information revealed in earlier turns? Scored 1 when there was no earlier context to use. |

All eight scores attach to the same `record-message` run, and (via
`experimentRef`) to that run's `chat-model-v3` experiment variant — so the
function dashboard's experiment view shows control vs. candidate spreads for
every one of them, including `valid-json` and the judge's
`category-correct`/`urgency-correct`.

## Golden dataset

Every reply and every score it earns also flows into a second pipeline that
builds a fine-tuning dataset out of real traffic. `record-message` and both
scorers emit `dataset/sample.captured.v3` / `dataset/score.captured.v3`
events (`.v3` for the same shared-Cloud-environment reason as the chat
events — see **Notes** below) instead of writing DuckDB directly. A single
function, `capture-dataset` (`src/inngest/capture.ts`, `concurrency: 1`), is
the only thing that ever opens `data/evals.duckdb` for writing — one global
writer lock across both event types, so sample writes and score writes can
never race each other on the same file. `bun run export` then reads that file
and produces `data/golden.jsonl`.

**Two tables, no foreign key, joined by a view.** `samples` (one row per
reply) and `scores` (one row per `{run_id, name}`) are independent — scores
for a run arrive at three different times relative to the sample itself:
`valid-json`/`latency-ms` land inline with the reply, the five judge scores
land seconds later once `judge-scorer` finishes its LLM call, and
`thumbs-up` can land up to a day later (or never) per `feedbackScorer`'s
`waitForEvent` timeout. A foreign key would force an ordering that doesn't
exist; the `golden` view instead joins whatever's there whenever it's
queried, so arrival order never matters. Both tables also capture
*everything*, not just what currently qualifies — so the golden threshold
can change later, or a rejected reply can feed a future DPO export, without
re-running anything.

**Golden criteria** (`CREATE OR REPLACE VIEW golden AS ...` in `src/db.ts`):

```
valid_json = 1
AND (thumbs_up = 1
     OR (thumbs_up IS NULL AND category_correct = 1 AND urgency_correct = 1
         AND avg(reply_quality, context_awareness) >= 0.8))
```

`valid_json = 1` is checked first and is unconditional: any reply that
doesn't parse as strict triage JSON is excluded no matter what else is
true — this is the fine-tune demo's core signal, so sloppy output never
becomes a golden sample regardless of thumbs or judge scores. Past that gate,
an explicit thumbs-down (`thumbs_up = 0`) always excludes a sample — it fails
both branches of the inner `OR`, the same NULL-propagation logic as before.
`sentiment_correct` is pivoted and exposed on the view for visibility but
intentionally **not** part of the `WHERE` clause: sentiment judgment is more
subjective than category/urgency, so it's recorded but doesn't gate. A
sample missing any of the required judge scores gets a `NULL` somewhere in
the pivot — missing `category-correct`/`urgency-correct` fails their own
`= 1` check directly, and missing `reply-quality` or `context-awareness`
makes `quality_avg` `NULL`, which fails `>= 0.8` — so partial judge data
excludes rather than being silently treated as passing.

**Export format.** `bun run export` writes one line per golden sample to
`data/golden.jsonl`, OpenAI chat-SFT style: `{"messages": [...]}` ending on an
assistant turn holding the captured reply. No system turn is included unless
`EXPORT_SYSTEM_PROMPT` is set — the captured `conversation` is exactly the
transcript the client sent, which does not include `TRIAGE_SYSTEM_PROMPT`
(that's added only inside `chat()` at call time, see `src/openrouter.ts`).
Leave `EXPORT_SYSTEM_PROMPT` unset for the fine-tune demo — see **The
fine-tune demo** below.

**Operational notes.** Stop the worker (`bun run dev`) before running `bun
run export` — DuckDB allows exactly one read-write process on a database file
at a time, and the worker holds `data/evals.duckdb` open read-write via
`capture-dataset` for as long as it runs. Export opens the file read-only
instead; if the worker still has it open, export prints a clear error and
exits 1 rather than a raw DuckDB IO error. Dataset capture also assumes a
single worker process — a second `INNGEST_INSTANCE_ID` instance would need
its own `EVALS_DB_PATH`, since two workers can't share one DuckDB file
read-write.

## The fine-tune demo

The point of the golden dataset is to demonstrate that a small model can
learn strict-JSON triage output *as a behavior baked into its weights*,
rather than depending on `TRIAGE_SYSTEM_PROMPT` at inference time. The flow:

1. Run `bun run populate` repeatedly (or once with a high `POPULATE_COUNT`)
   to build up volume of golden samples from real triage traffic.
2. Run `bun run export` to produce `data/golden.jsonl`. Leave
   `EXPORT_SYSTEM_PROMPT` **unset** for this demo — the exported transcript
   should end straight on the assistant's JSON reply with no system turn, so
   the fine-tune bakes the JSON-output behavior into the model itself instead
   of relying on a prompt the fine-tuned model might not even be served with.
3. Train a small (<7B parameter) model on that JSONL. Together.ai and
   Fireworks.ai both accept OpenAI-chat-style JSONL as-is for hosted
   fine-tuning; Unsloth or Axolotl work for a local run instead.
4. Set the resulting fine-tuned model's OpenRouter (or self-hosted)
   identifier as `OPENROUTER_MODEL_CANDIDATE` in `.env` and restart the
   worker. The existing `chat-model-v3` experiment view in the Inngest
   dashboard — the same one already comparing `control` vs. `candidate` — will
   show the candidate matching (or beating) control on `category-correct` /
   `urgency-correct` / `valid-json` while running at meaningfully lower
   `latency-ms`. Same dashboard, no new tooling, just a different model
   behind `candidate`.

## Why three different scoring mechanisms

- **`valid-json` / `latency-ms`** are cheap, deterministic, and known the
  moment the model call returns — so they're written inline with
  `inngest.score.experiment(...)` at function-body level, no separate run
  needed.
- **`thumbs-up`** isn't known until a human clicks something that may never
  happen, so it's a `createScorer` deferred run parked on
  `step.waitForEvent()`.
- **`category-correct` / `urgency-correct` / `sentiment-correct` /
  `reply-quality` / `context-awareness`** all come from a *single* judge LLM
  call — but
  `createScorer` only lets a handler return one `{name, value}` per run. To
  fan one call out into five independently-aggregating scores, `judgeScorer`
  (`src/inngest/scorers.ts`) is built with the lower-level `createDefer` +
  explicit `inngest.score(...)` / `inngest.score.experiment(...)` calls
  instead — one per score, all attributed back to the parent run via
  `parents[0]`.

## Flow

```
Browser                 Hono app + Connect worker        Inngest
  │                          │  ◀═════════════════════════╣ connect
  │ POST /api/chat           │     (websocket; functions   │
  │  {messages, convId?}     │      pushed down)           │
  │─────────────────────────▶│ validate messages           │
  │                          │ messageId = randomUUID()    │
  │                          │ conversationId = convId      │
  │                          │   ?? randomUUID()            │
  │                          │ inngest.send(               │
  │                          │   "chat/message.requested.v3")─▶ record-message run:
  │                          │                            │   group.experiment("chat-model-v3")
  │                          │ waitForReply(messageId)    │     step.run(call-model-*)
  │                          │   (in-process reply bus)   │       chat() → OpenRouter
  │ {reply, variant,         │  ◀── deliverReply(...) ────│       + latencyMs
  │  messageId,              │                            │   score.experiment(valid-json)
  │  conversationId}         │                            │   score.experiment(latency-ms)
  │◀─────────────────────────│                            │   defer(feedbackScorer)
  │                          │                            │   defer(judgeScorer)
  │ (shows 👍/👎 + variant)  │                            │   → done
  │ POST /api/feedback       │                            │ feedback-scorer run:
  │   {messageId, up}        │                            │   waitForEvent(
  │─────────────────────────▶│ inngest.send(              │     "chat/feedback.clicked.v3")
  │                          │   "chat/feedback.clicked.v3"───▶ scorer resumes →
  │ {ok:true}                │                            │   score(thumbs-up) attaches
  │◀─────────────────────────│                            │   to record-message run
  │                          │                            │ judge-scorer run:
  │                          │                            │   step.run("judge", judge())
  │                          │                            │   score.experiment(...) × 5
  │                          │                            │   → attach to record-message run
```

The model call happens **inside** the durable `record-message` run
(`step.run("call-model-*", ...)`), not on the HTTP request path. `POST
/api/chat` just validates the transcript, sends the triggering event, and
waits on the in-process reply bus (`waitForReply()` in `src/reply-bus.ts`)
for `record-message` to hand the reply back via `deliverReply()` — Inngest
Cloud's REST API doesn't expose run output, so it's only queried once, on
timeout, as a diagnostic (`fetchRunStatus()` in `src/index.ts`). This is what
lets AI metadata attach to the run (see below) and gives the model call
Inngest's retry/durability guarantees.

## AI metadata

`@inngest/otel` is preloaded via `bunfig.toml` (`preload =
["@inngest/otel/node"]`, Bun's equivalent of the docs' `node --import
@inngest/otel/node`), which registers the tracer provider and exporter — that
part works fine under Bun. Its automatic `openai` SDK instrumentation,
however, relies on Node module hooks that Bun doesn't fire, so the `openai`
client in `src/openrouter.ts` never gets patched. Instead, both `chat()` and
`judge()` emit the `gen_ai.*` span themselves (`tracer.startActiveSpan` with
the OTel GenAI semantic-convention attributes — `gen_ai.request.model`,
`gen_ai.usage.*`, `gen_ai.prompt.<i>.*` for every message in the conversation,
`gen_ai.completion.0.*`, etc.), which is the documented path for SDKs
`@inngest/otel` doesn't auto-instrument. The extraction result is identical
either way. Because the model call runs inside `step.run("call-model-*",
...)` in `record-message`, and the judge call runs inside `step.run("judge",
...)` in `judge-scorer`, those spans are captured against their respective
runs — open either run in the Inngest dashboard and check the **AI** tab to
see the model, token counts, and latency. See the
[AI metadata quickstart](https://www.inngest.com/docs/examples/ai-metadata-quickstart).

## Quick start

Two terminals. From this directory:

```sh
cp .env.example .env   # fill in OPENROUTER_API_KEY and OPENROUTER_MODEL
bun install
```

**Terminal 1** — the Inngest Dev Server (dashboard at http://localhost:8288):

```sh
bun run inngest
```

**Terminal 2** — the app:

```sh
bun run dev
```

Open http://localhost:3000 and paste in a customer ticket — e.g. "I was
charged twice for my subscription this month." You'll get back a triage card
(category/urgency/sentiment badges plus a suggested reply), not free text.
Send a follow-up that adds detail to the same ticket (e.g. "actually this
happened to my whole team") to see the re-triage account for it. Click 👍 or
👎 on a reply. Within a second or two, switch to the Dev Server: the
`record-message` run for that reply carries `valid-json` and `latency-ms`
immediately, `thumbs-up` after your click, and the five judge scores
(`category-correct`, `urgency-correct`, `sentiment-correct`, `reply-quality`,
`context-awareness`) once `judge-scorer` finishes its LLM call.

Want traffic without clicking through the UI yourself? `bun run populate`
plays out ~20 scripted ticket scenarios against the running app, checking
each reply's parsed category/urgency against a known expected value and
sending 👍/👎 accordingly — see `scripts/populate-scores.ts`.

## What to watch for in the Dev Server

- **`record-message`** — finishes once the model call returns. Its trace
  immediately shows `valid-json` and `latency-ms`; `thumbs-up` and the five
  judge scores appear later as the deferred runs below complete.
- **`feedback-scorer`** — a separate run per reply. It starts in a
  `wait-for-feedback` step and stays parked (Running) until your click
  resolves it — or until the 1-day timeout, in which case it returns `null`
  and records nothing.
- **`judge-scorer`** — a separate run per reply. Runs one `judge()` LLM call
  in a `judge` step, then writes `category-correct`, `urgency-correct`,
  `sentiment-correct`, `reply-quality`, and `context-awareness` as five
  separate score writes, all attaching to the originating `record-message`
  run.
- Open the function dashboard's **experiment** view for `chat-model-v3` to
  see every one of the eight scores split by `control` vs. `candidate`.

## Files

| File | Purpose |
|---|---|
| `src/ui/index.html` | Single-file React multiturn UI: sends the full transcript each turn, tracks `conversationId`, renders a triage card (category/urgency/sentiment badges + suggested reply) when the reply parses as triage JSON, shows 👍/👎 + a variant pill per reply. |
| `src/triage.ts` | Single source of truth for the triage task: `CATEGORIES`/`URGENCIES`/`SENTIMENTS` enum consts, the strict `TriageSchema` (zod), `parseTriage(reply)`, and `TRIAGE_SYSTEM_PROMPT`. |
| `src/openrouter.ts` | OpenRouter client; `chat(messages, model)` for triage replies (prepends `TRIAGE_SYSTEM_PROMPT`), `judge(messages, reply)` for the LLM-as-judge verdict (short-circuits to an all-false/0 verdict if the reply isn't valid triage JSON). |
| `src/inngest/client.ts` | Inngest client (`first-eval-example-phase-3`) with `scoreMiddleware()`. |
| `src/inngest/functions.ts` | `record-message`: durable `chat()` call + latency measurement via `step.run`, inline `valid-json`/`latency-ms` scores, then defers the feedback and judge scorers. |
| `src/inngest/scorers.ts` | `feedbackScorer` (`createScorer` + `waitForEvent`) and `judgeScorer` (`createDefer` + `inngest.score(...)` fan-out into five scores). Both also emit `dataset/score.captured.v3` for the golden dataset. |
| `src/inngest/capture.ts` | `capture-dataset`: the sole writer to `data/evals.duckdb`, triggered by `dataset/sample.captured.v3` / `dataset/score.captured.v3`. |
| `src/db.ts` | DuckDB connection singleton, schema (`samples`, `scores`), the `golden` view, and `upsertSample`/`upsertScore`. |
| `src/index.ts` | Connect worker + Hono app: `/` (UI), `/api/chat` (validates + sends the transcript), `/api/feedback`, `/ready`. No `/api/inngest`. |
| `scripts/populate-scores.ts` | Traffic generator: plays ~20 scripted ticket scenarios, comparing each parsed reply against a known expected category/urgency and sending deterministic 👍/👎 feedback accordingly. |
| `scripts/export-golden.ts` | Reads the `golden` view read-only and writes `data/golden.jsonl` (OpenAI chat-SFT JSONL), plus a summary of valid-JSON rate, golden rate, and judge-score distribution. |
| `bunfig.toml` | Preloads `@inngest/otel/node` for AI metadata extraction. |

## Notes

- **Connect, not serve.** The worker opens an outbound WebSocket to Inngest
  (`inngest/connect`); there's no inbound `/api/inngest` endpoint. Functions
  (`record-message`, `feedback-scorer`, `judge-scorer`, `capture-dataset`)
  auto-sync to the Dev Server the moment the worker connects — watch for `Worker: connected
  (ACTIVE)` in the console and the app appearing in the Dev Server's **Apps**
  view.
- **`/ready`** returns 200 only while the connect socket is `ACTIVE` — the
  readiness probe a load balancer would use in production.
- **Event names carry a `.v3` suffix** (`chat/message.requested.v3`,
  `chat/feedback.clicked.v3`). Phase 2 and phase 3 are separate Inngest apps
  but share one Cloud environment, and events fan out to every function whose
  trigger matches — regardless of app. Reusing phase 2's event names would
  spawn a phantom `record-message` run in the phase-2 app for every phase-3
  chat (hanging forever whenever that worker is offline), and `/api/chat`'s
  timeout diagnostics would sometimes latch onto it. Same keys, same environment —
  just distinct event names.
- **The client owns conversation state.** The server has none: every
  `/api/chat` request carries the full transcript it needs. `conversationId`
  is just a shared label for grouping runs, generated on the first turn and
  echoed back by the client on every turn after.
- **Message validation.** `/api/chat` rejects an empty or missing `messages`
  array, any entry that isn't `{role: "user"|"assistant", content: <non-empty
  string>}`, a transcript over 40 messages, or a transcript that doesn't end
  on a `user` turn.
- **One vote per message.** The UI disables the buttons after the first
  click. A second `chat/feedback.clicked.v3` for the same `messageId` finds no
  waiting scorer (it already completed) and is a no-op.
- **No click = no `thumbs-up`.** If the user never rates a message, the
  feedback scorer times out after 1 day and returns `null`, recording
  nothing — rather than logging a misleading default.
- **The judge scorer throws on unparseable output**, so an Inngest retry
  handles a judge model that ignores the "respond with only JSON"
  instruction, rather than silently recording garbage scores.
- **The UI is React via CDN** (`react`, `react-dom`, `@babel/standalone` from
  unpkg) in one HTML file. No frontend build step. It needs network access on
  first load to fetch those scripts.

## Docs

- [Inngest Connect](https://www.inngest.com/docs/setup/connect)
- [Build a deferred scorer](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring)
- [Score a function run](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/scoring)
