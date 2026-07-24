# token-streaming-agent

Streams an LLM's tokens **live to the browser** while the agent itself runs as
a durable [Inngest](https://www.inngest.com) function — using
[Inngest Realtime](https://www.inngest.com/docs/features/realtime), not a raw
SSE/WebSocket route of its own. The model is **Claude** (`claude-opus-4-8`)
via the Anthropic SDK.

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
cp .env.example .env   # fill in ANTHROPIC_API_KEY
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

The model API key (`ANTHROPIC_API_KEY`) is needed only on the worker side —
the Next.js app never calls the model directly.

## Demo prompt

> What's the weather in Tokyo, and what's 87\*23?

This exercises both tools (`get_weather`, `calculate`) in one run: watch the
tool-called/tool-result lines appear between streamed turns, and the run view
in the Dev Server show `llm-turn-0`, two `tool-*` steps, and `llm-turn-1`.
Send a follow-up afterward (e.g. "and London?") to confirm the full
conversation history round-trips correctly.

![video](https://cdn.inngest.com/docs/token-streaming/hls/master.m3u8)

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
instance can pick up any request) and keeps this example small, at the cost
of the browser being the only copy of history — refresh the tab and it's
gone. A real app would likely persist history (e.g. keyed by `sessionId`) and
send only the new message.

## Using a different provider

By default the worker talks to the real Anthropic API with `claude-opus-4-8`.
Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` to point it at any other
Anthropic-compatible endpoint instead — no code changes needed.
