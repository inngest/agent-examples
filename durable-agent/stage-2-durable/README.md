# Stage 2 — Durable: the same agent, made crash-safe with Inngest

The **"after"**. This is the exact same agent as
[`../stage-1-fragile`](../stage-1-fragile) — same tool, same loop, same prompt —
but the model call and each tool call are now independent, memoized
[Inngest](https://www.inngest.com) steps running in the background:

- The **orchestrator** (`run-agent`) drives the loop. Its model call is wrapped
  in `step.run("call-model", …)`, so a downstream crash never re-calls the model.
- Each **tool** gets its own durable function (`tool-charge_credit_card`) with
  `retries: 5`. The orchestrator invokes it with `step.invoke` and gets the
  result back directly — no event correlation — and it isn't running while the
  tool retries.

When the tool fails, only the tool retries. The orchestrator sits parked while
the tool runs and never restarts, so a completed charge is never re-issued.

## Setup

### Local development

Two terminals. **Terminal 1** — the app (with `INNGEST_DEV=1` it connects to
the Dev Server instead of Inngest Cloud):

```sh
cp .env.example .env   # fill in ANTHROPIC_API_KEY (or point at any Anthropic-compatible endpoint)
bun install
INNGEST_DEV=1 bun run dev
```

**Terminal 2** — the Inngest Dev Server (dashboard at http://localhost:8288):

```sh
bun run inngest
```

### Inngest Cloud (production)

This app uses [Connect](https://www.inngest.com/docs/setup/connect) — an
outbound persistent WebSocket from the worker to Inngest. No public ingress is
required; Inngest pushes step invocations to connected workers.

1. Grab `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from app.inngest.com and
   put them in `.env`. Also set `INNGEST_APP_VERSION` (e.g. a git sha) so
   rolling deploys work.
2. Run the worker on any long-lived host (Fly, Render, Kubernetes, etc.):
   ```sh
   bun run dev
   ```
   On connect, functions are synced to Cloud automatically — no manual app
   sync needed. Watch runs in the Cloud dashboard.

There is no `/api/inngest` serve endpoint anymore; the only inbound surface is
the trigger route and a `/ready` health probe.

## Endpoints

- `POST /api/agent` — `{ "prompt": "..." }` fires an `agent/run.requested` event
  and returns `{ "eventId": "..." }`. The run happens in the background — watch it
  in the dashboard.
- `GET /ready` — health/readiness probe; returns 200 when the connect socket is `ACTIVE`.

## Demoing the self-heal

The mock payment gateway is deliberately flaky: every `charge_credit_card` fails
its first attempt or two, then goes through. No switch to flip — just fire a run:

```sh
bun run agent          # -> {"eventId":"..."}
```

In the dashboard you'll see a `run-agent` run and, linked inside it, a
`tool-charge_credit_card` run that fails once or twice (its own `retries: 5`) and
then succeeds. `run-agent` never restarts and never re-calls the model — it was
just parked waiting on the invoked tool. The final output shows the completed
charge, issued **exactly once**.

The failure is keyed by the charge's idempotency key, so each run heals on its
own — fire it as many times as you like.

## The last-mile guarantee: idempotency

Memoization stops *downstream* failures from re-running a completed step. It does
**not** cover the case where the charge succeeds but the process dies before the
step records completion — that's genuine at-least-once execution. The real fix is
to thread the unique `toolCallId` to the payment provider as an idempotency key,
so a duplicate request is deduplicated at the API. `toolCallId` flows through the
`step.invoke` call (`agent.ts` → `tool-functions.ts`) and into `executeTool`,
which passes it to the (mock) charge — so it's already the natural key to hand a
real provider (e.g. Stripe's `Idempotency-Key`).

## Using a different provider

Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in `.env` — `src/agent.ts` reads
both directly from the SDK client config, so no code changes are needed.
