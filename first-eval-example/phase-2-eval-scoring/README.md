# Phase 2 — Human-feedback scoring (deferred)

A chat UI where the user rates each reply with 👍 / 👎. The rating is captured
by a **deferred scorer** — a separate [Inngest](https://www.inngest.com)
function run that parks on a `step.waitForEvent()`, waits for the click, and
then attaches a `thumbs-up` score to the original message run. Scores land on
the run trace in the Dev Server and aggregate in the function dashboard.

This is the pattern the
[deferred scoring guide](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring)
describes: the outcome (did the user like the reply?) isn't known when the run
finishes, so scoring has to wait.

The worker uses [Inngest Connect](https://www.inngest.com/docs/setup/connect):
an outbound persistent WebSocket to Inngest, so there's **no `/api/inngest`
serve endpoint**. Functions auto-sync when the worker connects, and long-running
steps (like the scorer's 1-day `waitForEvent`) aren't bound by HTTP timeouts.

## Flow

```
Browser                 Hono app + Connect worker        Inngest
  │                          │  ◀═════════════════════════╣ connect
  │ POST /api/chat {prompt}  │     (websocket; functions   │
  │─────────────────────────▶│ messageId = randomUUID()    pushed down)
  │                          │ waitForReply(messageId)    │
  │                          │   (in-process reply bus)   │
  │                          │ inngest.send(              │
  │                          │   "chat/message.requested")─▶ record-message run:
  │                          │                            │   step.run("call-model")
  │                          │                            │     chat() → OpenRouter
  │ {reply, messageId}       │  ◀── deliverReply(...) ────│   defer(feedbackScorer)
  │◀─────────────────────────│                            │   → done
  │                          │                            │ feedback-scorer run:
  │                          │                            │   waitForEvent(
  │ (shows 👍/👎)            │                            │     "chat/feedback.clicked")
  │ POST /api/feedback       │                            │
  │   {messageId, up}        │                            │
  │─────────────────────────▶│ inngest.send(             │
  │                          │   "chat/feedback.clicked"───▶ scorer resumes →
  │ {ok:true}                │                            │   score attaches to
  │◀─────────────────────────│                            │   record-message run
```

The model call now happens **inside** the durable `record-message` run
(`step.run("call-model", ...)`), not on the HTTP request path. `POST
/api/chat` sends the triggering event and waits on the in-process reply bus
(`waitForReply()` in `src/reply-bus.ts`) for `record-message` to hand the
reply back via `deliverReply()` — Inngest Cloud's REST API doesn't expose run
output, so it's only queried once, on timeout, as a diagnostic
(`fetchRunStatus()` in `src/index.ts`). This is what lets AI metadata attach
to the run (see below) and gives the model call Inngest's retry/durability
guarantees; the deferred scoring lifecycle is otherwise unchanged — the run
still exists so the scorer has somewhere to attach the score.

## AI metadata

`@inngest/otel` is preloaded via `bunfig.toml` (`preload =
["@inngest/otel/node"]`, Bun's equivalent of the docs' `node --import
@inngest/otel/node`), which registers the tracer provider and exporter — that
part works fine under Bun. Its automatic `openai` SDK instrumentation,
however, relies on Node module hooks that Bun doesn't fire, so the `openai`
client in `src/openrouter.ts` never gets patched. Instead, `chat()` emits the
`gen_ai.*` span itself (`tracer.startActiveSpan` with the OTel GenAI
semantic-convention attributes — `gen_ai.request.model`, `gen_ai.usage.*`,
`gen_ai.prompt.0.*`, `gen_ai.completion.0.*`, etc.), which is the documented
path for SDKs `@inngest/otel` doesn't auto-instrument. The extraction result
is identical either way. Because the model call now runs inside
`step.run("call-model", ...)` in `record-message`, those spans are captured
against that run — open the `record-message` run in the Inngest dashboard
(Dev Server locally, or app.inngest.com against Cloud) and check the **AI**
tab to see the model, token counts, and latency. See the
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

Open http://localhost:3000, send a message, and click 👍 or 👎 on the reply.
Within a second or two, switch to the Dev Server: the `record-message` run now
carries a `thumbs-up` score (1 or 0) on its trace.

## What to watch for in the Dev Server

- **`record-message`** — finishes almost instantly (it just defers the scorer
  and returns). After you click, refresh the run and the `thumbs-up` score
  appears on its trace.
- **`feedback-scorer`** — a separate run. It starts in a `wait-for-feedback`
  step and stays parked (Running) until your click resolves it — or until the
  1-day timeout, in which case it returns `null` and records nothing.
- After several rated messages, open the function dashboard to see `thumbs-up`
  aggregating over time.

## Files

| File | Purpose |
|---|---|
| `src/ui/index.html` | Single-file React chat UI with the 👍/👎 component. |
| `src/openrouter.ts` | OpenRouter client; `chat(prompt)`. |
| `src/inngest/client.ts` | Inngest client with `scoreMiddleware()`. |
| `src/inngest/functions.ts` | `record-message`: durable `chat()` call via `step.run`, then defers the feedback scorer. |
| `src/inngest/scorers.ts` | `feedbackScorer`: `createScorer` + `waitForEvent`. |
| `src/reply-bus.ts` | In-process reply hand-off: `waitForReply()`/`deliverReply()` connect the HTTP request to the `record-message` run in the same process. |
| `src/index.ts` | Connect worker + Hono app: `/` (UI), `/api/chat`, `/api/feedback`, `/ready`. No `/api/inngest`. |
| `bunfig.toml` | Preloads `@inngest/otel/node` for AI metadata extraction. |

## Notes

- **Connect, not serve.** The worker opens an outbound WebSocket to Inngest
  (`inngest/connect`); there's no inbound `/api/inngest` endpoint. Functions
  (`record-message`, `feedback-scorer`) auto-sync to the Dev Server the moment
  the worker connects — watch for `Worker: connected (ACTIVE)` in the console
  and the app appearing in the Dev Server's **Apps** view.
- **`/ready`** returns 200 only while the connect socket is `ACTIVE` — the
  readiness probe a load balancer would use in production.
- **One vote per message.** The UI disables the buttons after the first click.
  A second `chat/feedback.clicked` for the same `messageId` finds no waiting
  scorer (it already completed) and is a no-op.
- **No click = no score.** If the user never rates a message, the scorer times
  out after 1 day and returns `null`, recording nothing — rather than logging a
  misleading default.
- **The UI is React via CDN** (`react`, `react-dom`, `@babel/standalone` from
  unpkg) in one HTML file. No frontend build step. It needs network access on
  first load to fetch those scripts.

## Docs

- [Inngest Connect](https://www.inngest.com/docs/setup/connect)
- [Build a deferred scorer](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring)
- [Score a function run](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/scoring)
