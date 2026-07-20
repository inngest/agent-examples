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
- `POST /api/kill-switch` — `{ "enabled": true }` flips a live in-memory switch.
  While enabled, the `charge_credit_card` tool throws instead of succeeding.
- `GET /api/kill-switch` — current switch state.

## Demoing the failure live

```sh
bun run kill-switch:on
bun run agent
```

The tool throws, nothing catches it, and the request comes back `500` — every
prior tool call and message in that run is gone. Retrying the request re-runs the
loop **from scratch**, re-charging any card that already succeeded. That's the
failure mode stage 2 fixes: wrapping each tool call as an Inngest step means a
retry resumes from the failed step instead of from the beginning.

```sh
bun run kill-switch:off
```

## Using a different provider

Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in `.env` — `src/agent.ts` reads
both directly from the SDK client config, so no code changes are needed. This
works with any Anthropic-compatible endpoint (e.g. MiniMax).
