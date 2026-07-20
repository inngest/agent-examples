# Stage 1 — Fragile: a plain Anthropic SDK agent

A minimal tool-calling agent loop, using the Anthropic SDK, served over Bun's
native HTTP server. This is the **"before"**: the model and its tools run inline
inside the HTTP request, with no failure recovery. One uncaught tool error takes
the whole run down — including any charges already made.

[`../stage-2-durable`](../stage-2-durable) wires the *same* agent through Inngest
so a mid-run failure becomes a resumable step instead of a dead request. See
[`../TRANSFORMATION.md`](../TRANSFORMATION.md) for the edit-by-edit diff.

## Setup

```sh
cp .env.example .env   # fill in ANTHROPIC_API_KEY (or point at any Anthropic-compatible endpoint)
bun install
bun run dev
```

## Endpoints

- `POST /api/agent` — `{ "prompt": "..." }` runs the agent loop (`charge_credit_card`
  tool) and returns the final content blocks.

## Demoing the failure live

The mock payment gateway fails at random — each `charge_credit_card` attempt
throws with probability `CHARGE_FAILURE_RATE` (default `0.5`). Fire a few runs:

```sh
bun run agent
bun run agent
```

Roughly half the runs come back `500`: the tool throws, nothing catches it, and
every prior tool call and message in that run is gone. Retrying re-runs the loop
**from scratch**, re-charging any card that already succeeded. That's the failure
mode stage 2 fixes: wrapping each tool call as an Inngest step means a retry
resumes from the failed step instead of from the beginning.

Set `CHARGE_FAILURE_RATE=1` in `.env` to force the break every time (handy for a
recording), or `0` to always succeed.

## Using a different provider

Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in `.env` — `src/agent.ts` reads
both directly from the SDK client config, so no code changes are needed. This
works with any Anthropic-compatible endpoint (e.g. MiniMax).
