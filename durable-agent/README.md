# Durable Agent — when your agent can spend money

<!--Companion code for the Inngest blog post
**[Your agent just learned to spend money](https://www.inngest.com/blog/your-agent-just-learned-to-spend-money)**.-->

An AI agent that calls a `charge_credit_card` tool has a nasty failure mode: if a
tool throws (or the process dies) mid-run, a naive retry re-runs the whole agent
loop from the top — re-charging any card that already succeeded. This repo shows
the problem and the fix, side by side.

## The two stages

| | |
|---|---|
| [`stage-1-fragile/`](./stage-1-fragile) | The agent loop runs inline in the HTTP request. One uncaught tool error `500`s the whole run; retrying it re-charges. **Run it to watch it break.** |
| [`stage-2-durable/`](./stage-2-durable) | The *same* agent, with the model call and each tool call as independent, memoized [Inngest](https://www.inngest.com) steps. A failed tool retries on its own; the orchestrator never restarts and never re-charges. **Run it to watch it heal.** |

The tool's charge logic (`src/tools.ts`) is the same in both stages — only the
orchestration changes. Stage 2 additionally threads a `toolCallId` idempotency
key through `executeTool` (the last-mile exactly-once guarantee).
[`TRANSFORMATION.md`](./TRANSFORMATION.md) walks through the change edit by edit.

## Quick start

Each stage is a standalone [Bun](https://bun.sh) project. See its README for the
full walkthrough.

```sh
# Stage 1: see it break (the mock charge fails at random)
cd stage-1-fragile && bun install && cp .env.example .env
bun run dev
bun run agent   # run a few times: ~half 500 and the run is lost

# Stage 2: see it heal (needs a second terminal for `bun run inngest`)
cd stage-2-durable && bun install && cp .env.example .env
bun run dev
bun run agent   # the charge fails a try or two, the tool retries, then succeeds
```

Both stages need an `ANTHROPIC_API_KEY` in `.env` (or any Anthropic-compatible
`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`).
