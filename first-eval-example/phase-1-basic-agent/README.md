# Phase 1 — Basic Agent

A minimal durable agent: a single LLM call wrapped in one [Inngest](https://www.inngest.com)
step, routed through [OpenRouter](https://openrouter.ai) via the official
`openai` SDK. The point of this phase is the smallest possible "durable
function that calls a model" — nothing more.

## What it shows

- One Inngest function (`agent-run`) triggered by an event.
- One durable `step.run("call-model", …)` around the OpenRouter call. If the
  process dies mid-call, the retry re-runs *only* this step — the orchestrator
  never restarts from scratch.
- A tiny [Hono](https://hono.dev) HTTP server that serves `/api/inngest`
  (Inngest's discovery endpoint) and `POST /api/agent` (sends the trigger event).

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

Then trigger a run:

```sh
bun run agent
```

That POSTs `{"prompt": "In one sentence, why is the sky blue?"}`. Watch the run
appear in the Dev Server's **Runs** tab — click into it to see the single
`call-model` step and its output.

## Picking a model

Set `OPENROUTER_MODEL` in `.env` to any OpenRouter-routed model id, e.g.
`openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku`, or
`google/gemini-2.0-flash-001`. You can also override per-request:

```sh
curl -X POST localhost:3000/api/agent \
  -H 'content-type: application/json' \
  -d '{"prompt": "What is 2+2?", "model": "anthropic/claude-3.5-haiku"}'
```

## Files

| File | Purpose |
|---|---|
| `src/openrouter.ts` | `openai` SDK pointed at OpenRouter; exports `chat(prompt)`. |
| `src/inngest/client.ts` | The Inngest client. |
| `src/inngest/functions.ts` | The `agent-run` function — one durable step. |
| `src/index.ts` | Hono app: `/api/inngest` (serve) + `/api/agent` (trigger). |

## Next

Open [`../phase-2-eval-scoring/`](../phase-2-eval-scoring/) — the same agent
behind a chat UI, where each reply gets a human 👍/👎 captured by a deferred
scorer.

Then [`../phase-3-multiturn-evals/`](../phase-3-multiturn-evals/) adds an
LLM-as-judge, multiturn support-ticket triage, and a golden dataset for a
fine-tune demo.
