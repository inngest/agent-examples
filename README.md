# Durable Agent — Stage 1: plain Anthropic SDK agent

A minimal tool-calling agent loop, using the Anthropic SDK, served over Bun's
native HTTP server. This is the "before" — stage 2 wires the same agent
through Inngest so a mid-run failure becomes a resumable step instead of a
dead request.

## Setup

```sh
cp .env.example .env   # fill in ANTHROPIC_API_KEY (or point at MiniMax — see below)
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
prior tool call and message in that run is gone. That's the failure mode
stage 2 fixes: wrapping the same tool calls as Inngest steps means a retry
resumes from the failed step instead of from scratch.

## Using MiniMax (or any Anthropic-compatible endpoint) instead

Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in `.env` — `src/agent.ts` reads
both directly from the SDK client config, so no code changes are needed.
