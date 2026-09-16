# Durable Architecture — Talking Points

A Claude agent runs as a **durable Inngest function**, streaming tokens to the
browser over Inngest Realtime. The design assumption is that *everything flaky
will fail* — the network, the worker, the model, the tab — and the run still
lands correctly.

### 1. The agent loop is durable, not in-memory

Every model turn and every tool call is a **memoized `step.run`**. If the worker
crashes or is redeployed mid-run, Inngest resumes from the last completed step —
finished steps never re-execute, so the model is never re-billed and tools never
double-fire. The multi-turn tool loop is bounded by `MAX_TURNS` and a
per-response `max_tokens`, so a misbehaving model can't run up unbounded cost or
time.

### 2. Streaming is a side effect, never the source of truth

Token deltas are fire-and-forget (`inngest.realtime.publish`) — cheap,
non-durable UI candy. The **authoritative record** is the durable
`turn.completed` / `run.completed` status events (`step.realtime.publish`). If a
token batch is dropped, the durable event still carries the full text. If a step
**retries**, it re-streams from `seq: 0` and the UI resets that turn's buffer —
so a retry looks like a clean re-render, not garbled output.

### 3. Realtime has no replay — so we don't depend on it

Inngest Realtime doesn't backfill late subscribers. A dropped connection or a
mid-run refresh **can** miss `run.completed`. So the client also polls a
stateless **catch-up endpoint** (`/api/run-status`) that reads the run's result
straight from the Inngest run record. Whichever arrives first — the live event
or the poll — commits, **guarded so the reply is appended at most once**. The
Inngest run is the single source of truth; our server stays stateless.

### 4. The client is durable too

The full transcript, the in-flight `pendingEventId`, and the sticky model choice
are persisted to `localStorage`. A reload re-subscribes for the live tail *and*
fires the catch-up poll, so a conversation — and an in-flight reply — survives a
refresh or a closed tab.

### 5. Scoring can never break the chat

Evaluation (LLM judges + deterministic tool-quality scores) runs **after** the
reply is already streamed, via `Promise.allSettled`. A flaky judge or a rate
limit degrades scoring silently — it can never turn a good answer into a failed
run. User feedback (👍/👎) is collected via **deferred scoring**, which parks on
a `waitForEvent` long after the run finishes.

### 6. No public ingress

The worker holds an **outbound** WebSocket via Inngest Connect — no serve route,
no inbound port. Inngest pushes work to it, and the connection auto-reconnects
with edge-triggered diagnostics (state transitions + heartbeat-stall warnings)
for observability on bad links.

### 7. Failure is terminal, once — never a false alarm

Failure is surfaced to the UI from an `onFailure` handler, so the user is
notified **once, only after retries are exhausted** — a transient error
mid-retry no longer flashes a failure that a successful retry then contradicts.
Non-retriable model errors (4xx) are wrapped in `NonRetriableError` so they fail
fast instead of burning the retry budget.

### 8. Durable cancellation

A **Stop** button cancels the run durably via `cancelOn` — the browser sends a
`chat/cancel.requested` event and Inngest tears the run down at the next **step
boundary** (so it stops subsequent turns/tools rather than interrupting the
in-flight LLM stream mid-token, which is exactly the useful behavior for a
multi-turn tool loop). The UI settles instantly to a distinct, non-error
"stopped" state.

---

**The one-liner:** *The stream is disposable; the durable run is the truth.
Every layer — worker, function, transport, client — assumes the one below it can
drop, and recovers from the run record.*
