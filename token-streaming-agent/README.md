# token-streaming-agent

Streams an LLM's tokens **live to the browser** while the agent itself runs as
a durable [Inngest](https://www.inngest.com) function — using
[Inngest Realtime](https://www.inngest.com/docs/features/realtime), not a raw
SSE/WebSocket route of its own. Models are served through
[OpenRouter](https://openrouter.ai) (OpenAI-compatible API), A/B testing two
arms — `MODEL_A` vs `MODEL_B` — that default to **Claude Sonnet**
(`anthropic/claude-sonnet-5`) and **NVIDIA Nemotron**
(`nvidia/nemotron-3-ultra-550b-a55b`) but accept any OpenRouter slug.

## Flow

```
Browser                    Next.js route handlers          Connect worker (Bun)
   |                                |                                |
   | POST /api/chat                |                                |
   |------------------------------->|  inngest.send("chat/message.sent")
   |                                |------------------------------->|
   |                                |                                |  chat-agent runs:
   |                                |                                |  - streams model tokens
   |                                |                                |  - calls tools
   | POST /api/realtime-token       |                                |  - publishes to chat:{sessionId}
   |------------------------------->|  getClientSubscriptionToken    |
   |<-------------------------------|                                |
   | useRealtime(token) subscribes directly to Inngest's realtime API|
   |<===============================================================|
   |   tokens: {turn, seq, delta}         status: run.started / tool.called /
   |                                      tool.result / turn.completed /
   |                                      run.completed / run.failed
```

**There is no `/api/inngest` serve route anywhere in this app.** The
`chat-agent` function is registered *only* inside the standalone worker
(`src/worker/index.ts`), via [Connect](https://www.inngest.com/docs/setup/connect) —
an outbound persistent connection from the worker to Inngest. The Next.js app
only ever sends events and mints realtime subscription tokens; it never
executes a step.

## Local setup

Three terminals:

```sh
cp .env.example .env   # fill in OPENROUTER_API_KEY
bun install
```

**Terminal 1** — the Inngest Dev Server (dashboard at http://localhost:8288):

```sh
bun run inngest
```

**Terminal 2** — the worker. With `INNGEST_DEV=1` (already set in
`.env.example`) it connects to the Dev Server instead of Inngest Cloud:

```sh
bun run worker
```

You should see `Worker: connected` — and the `token-streaming-agent` app with
its `chat-agent` function appear in the Dev Server, synced automatically over
the connect socket (no manual app registration).

**Terminal 3** — the Next.js app:

```sh
bun run dev
```

Open http://localhost:3000 and send the demo prompt.

## Inngest Cloud (production)

1. Grab `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from app.inngest.com and
   set them (plus `INNGEST_APP_VERSION`, e.g. a git sha) wherever both the
   Next.js app and the worker run.
2. Deploy the Next.js app anywhere that can serve `/api/chat` and
   `/api/realtime-token` (e.g. Vercel).
3. Run the worker (`bun run worker`, or `bun run src/worker/index.ts` from a
   build) on any long-lived host — Fly, Render, a container on Kubernetes,
   etc. On connect, `chat-agent` is synced to Cloud automatically.

The model API key (`OPENROUTER_API_KEY`) is needed only on the worker side —
the Next.js app never calls the model directly.

## Demo prompt

> Analyze the last month of weather in Tokyo — average high and low, the rainiest day, and whether it's warming or cooling.

This exercises the full agent loop across several turns: the model fetches
Tokyo's history and then writes a Python script (`run_python`) to aggregate the
30-day daily series — averages, the max-precipitation day, a warming/cooling
trend — which runs in the [Monty](https://github.com/pydantic/monty) sandbox and
prints its results back. Watch the tool-called/tool-result lines appear between
streamed turns, with the **Python source and its printed output rendered as code
blocks** in the trace; the run view in the Dev Server shows the `llm-turn-*`
steps each followed by a `tool-*` step (including `tool-run_python-*`).
Send a follow-up afterward (e.g. "now compare that with London") to confirm the
full conversation history round-trips correctly.

## Design notes

**Channel/topic design.** One channel per session, `chat:{sessionId}`
(`src/inngest/channel.ts`), with two topics:

- `tokens` — `{ turn, seq, delta }`, one message per ~40ms batch of streamed
  text. High frequency, ephemeral: it's a live nicety, not the record of
  truth.
- `status` — lifecycle events (`run.started`, `tool.called`, `tool.result`,
  `turn.completed`, `run.completed`, `run.failed`). Low frequency,
  authoritative.

**Non-durable vs. durable publishes.** Token deltas are published with
`inngest.realtime.publish(...)` — the client-level, non-durable call. It's not
memoized and doesn't survive a step retry, which is exactly what you want for
a live-typing effect: if the step retries, you *want* it to restream. Every
status message, by contrast, is published with `step.realtime.publish(id, ...)`
— a durable step in its own right, memoized like any other. That's what makes
`turn.completed` trustworthy as the authoritative text for a turn even if the
underlying model call was retried and restreamed its tokens.

**`seq: 0` replay semantics.** Each per-turn model call is one
`step.run("llm-turn-N", …)`. If that step is retried (say, the worker
crashes mid-stream), the retry starts a brand new stream from `seq: 0`.
`Chat.tsx` treats a reappearing `seq: 0` for a turn it's already seen as "this
is a new attempt" and throws away the partial buffer from the previous
attempt before rebuilding from the new one. Nothing needs deduping at the
transport level — the UI's grouping logic handles it.

**Client-owned history trade-off.** There's no server-side session store:
the browser holds the full transcript and POSTs it in full on every
`/api/chat` call. That keeps the server completely stateless (any worker
instance can pick up any request) and keeps this example small. The browser
copy is made reload-safe by two client-side pieces: the session id lives in
the URL (`?session=<id>`) and the transcript is mirrored to `localStorage`
(`chat:<id>`, pruned after 7 days), so refreshing — or recovering from a
timed-out run — picks the conversation back up on the same device. The
in-flight run's event id is persisted too, so a reload knows which run to
recover (see catch-up below). Events are also tagged with Inngest session
context (`meta.sessions.conversation_id`), which groups every run of one
conversation under **AI → Sessions** in the Cloud dashboard for eval
debugging. A real app wanting cross-device resume would persist history
server-side and send only the new message.

**Live-only subscription + catch-up recovery.** The browser only subscribes
while a run is in flight (`enabled: running` in `Chat.tsx`), and Inngest
Realtime delivers live messages only — there's no backfill for a subscriber
that joins late. So a dropped connection or a mid-run reload can miss the
terminal `run.completed`, and realtime alone can't get it back. To recover,
while a run is in flight the client also polls `GET /api/run-status?eventId=…`,
which asks Inngest's REST API (`/v1/events/{id}/runs`) for the run's status and
output. Whichever arrives first — the live `run.completed` or a `completed`
poll — commits the reply, guarded so it's appended at most once. This keeps the
server stateless (the Inngest run record is the source of truth) while making
the reply survive a bad connection. The recovered reply keeps its tool context
(`newMessages`, returned from the function) and its event id, so it's still
rateable — and the collapsible tool *trace* is reconstructed from those same
`newMessages` (assistant `tool_calls` + `tool` results), so a recovered reply
shows its full agent trace even though the live `tool.*` events were never
replayed.

**Terminal failure, exactly once.** The chat function sets `retries: 3`, and
because every turn and tool call is a memoized `step.run`, a retry replays the
completed steps for free and only re-runs from the one that failed — the model
is never re-billed for turns that already finished. Crucially, failure is
surfaced to the UI from the function's `onFailure` handler, which fires **once,
only after all retries are exhausted**. (Earlier the agent published
`run.failed` from its own catch on every attempt, so a transient error would
show the user a permanent failure that a later retry then contradicted.) The
agent also classifies errors before rethrowing: a 4xx from the model — an
invalid request that will fail identically on retry — is wrapped in
`NonRetriableError` so it fails fast to `onFailure` instead of burning the retry
budget, while 5xx/network/429 errors stay retriable.

**Durable cancellation (Stop).** While a run is in flight the composer shows a
**Stop** button. Clicking it POSTs `/api/cancel`, which sends a
`chat/cancel.requested` event; the chat function declares
`cancelOn: [{ event: "chat/cancel.requested", if: "async.data.sessionId ==
event.data.sessionId" }]`, so Inngest tears the matching run down durably — from
outside the worker — at its next **step boundary**. (It stops subsequent
turns/tools rather than interrupting the in-flight LLM stream mid-token, which
is the useful behavior for a multi-turn tool loop.) The UI settles instantly to
a neutral "stopped" state via a distinct `run.cancelled` status, and
`/api/run-status` reports `cancelled` (not `failed`) as a backstop for a client
that missed the live event.

**Python analysis via a pluggable sandbox.** Beyond the weather/conversion
tools, the agent has a `run_python` tool: the model writes a short Python script
to analyze the ~30-day daily history (trends, aggregates, correlations), and the
worker injects the requested cities' readings into the script as a `weather`
variable — the same deterministic data `get_weather_multi` returns, so nothing is
retyped. Generated code must run **only in a sandbox**, so execution goes through
a pluggable `PythonRunner` interface (`src/worker/sandbox/`): the tool, agent,
and UI depend only on that interface, so the backend is a one-line swap. Today it
ships a no-op placeholder (returns "not configured yet"); it's backed by
[Monty](https://github.com/pydantic/monty) (`@pydantic/monty`, a Rust-based
secure Python interpreter) next, and can be swapped for Inngest Sandboxes after
that. Monty runs a restricted Python subset — stdlib `json`/`datetime`/`re`
only, no third-party packages, no classes — which the system prompt tells the
model about so it writes compatible scripts. The trace renders the script and its
output as code blocks.

## Using a different provider

By default the worker talks to OpenRouter via the OpenAI SDK
(`worker/openrouter.ts`). Set `OPENROUTER_BASE_URL` to point it at any other
OpenAI-compatible endpoint instead — no code changes needed. Override the
model(s) it uses via `MODEL_A`, `MODEL_B`, and `JUDGE_MODEL` (see below); any
OpenRouter slug works, so swapping in different models is just an env change.

## Model experiment & scoring

`chat-function.ts` runs every session through
`group.experiment("weather-chat-bot", …)`, bucketing it 50/50 into two arms —
`MODEL_A` vs `MODEL_B` (Claude Sonnet vs NVIDIA Nemotron by default, but any
OpenRouter slugs) — via `experiment.bucket(sessionId, …)`, so one conversation
always sticks with the model it started with. After each run, the response is
scored on five metrics:

- **conciseness** and **helpfulness** — LLM judge (`JUDGE_MODEL`, defaulting to
  `anthropic/claude-opus-4.8` through OpenRouter).
- **tool-efficiency** — deterministic: unique tool calls / total calls, so a
  model that loops on the same call scores lower.
- **tool-call-validity** — deterministic tool-*emit* quality: of the calls a
  model emitted, the fraction with parseable JSON arguments **and** all
  schema-required params present. Skipped when no tools were called. This is
  the sharpest signal for which model forms tool calls better (e.g. a model
  that streams broken JSON or drops a required field scores lower).
- **tool-use-correctness** — LLM judge: did the model call the tools the
  request actually needed? Catches the case the deterministic scores can't —
  answering from memory when a tool was required, or calling the wrong tool.

Each score is attached to the selected variant with
`inngest.score.experiment(...)`, so the Inngest dashboard can compare the two
arms on these metrics across runs. Scoring is best-effort and never fails
the chat run — the reply is
already streamed to the browser by the time scoring happens.
