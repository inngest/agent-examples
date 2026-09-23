# Hero copy — token-streaming-agent

Source copy for landing pages, demos, and talks. Every claim below is backed by
this codebase; proof points reference exact files so copy and code don't drift.

---

## Hero

**Headline:**

> An AI agent that streams like magic and never loses your run.

**Subhead:**

> Watch tokens appear live in the browser — while every turn and tool call
> runs as a durable, individually retryable step. If step 47 fails, we retry
> step 47. Steps 1 through 46 are replayed from memory in milliseconds.

### Alternate headlines

1. **Live token streaming. Durable by default.** The chat feels instant; the
   execution is bulletproof.
2. **Kill the worker mid-stream. The agent picks up where it left off.**
   Durable execution for agents, live streaming for humans.
3. **If step 47 fails, retry step 47 — not steps 1 through 46.** And you
   never had to declare steps 1–47 in advance.

---

## The story

AI agents don't fail in convenient places. A model call times out on turn 12.
A tool call flakes. The process dies mid-stream. In a plain request/response
app, any of those means starting over — re-running every model call,
re-paying for every token, re-waiting through every turn.

This agent takes a different shape. It runs as a durable Inngest function:
each LLM turn is one step, each tool call is one step. When something fails,
only that step retries. Everything before it is memoized — results replayed
from memory, no re-execution, no re-billing. The retry re-streams its tokens
from `seq: 0`, and the UI resets gracefully to match.

Here's the part traditional workflow engines can't do: **nobody wrote down
how many steps this agent would take.** Each step is created dynamically, in
a runtime loop, because you don't know how many turns or tool calls your
agent will use — the model decides as it goes. Durable execution that fits
an agent's shape, not the other way around.

And none of it costs you the live feel. Tokens stream to the browser over
Inngest Realtime as they're generated, interleaved with tool-call events —
no separate WebSocket server, no SSE route to babysit. Streaming is the side
effect. Durability is the guarantee.

---

## Quotable claims

Use verbatim; each is verifiably true in this repo.

- **"If step 47 fails, retry step 47 — not steps 1 through 46."**
  Completed steps are memoized; a retry replays their results instantly
  without re-executing or re-billing them.

- **"Every step is created dynamically — you don't know how many turns or
  tool calls your agent will use, and you don't have to."** Steps are
  generated in a loop at runtime; there's no upfront DAG to declare.

- **"Tokens stream live while the run stays durable."** Token deltas are
  ephemeral realtime publishes; the completed text of each turn is a durable,
  memoized event. Live nicety, authoritative record.

- **"Kill the worker mid-stream — the run resumes and finishes."** The
  Connect worker holds no state; Inngest re-drives the function and the
  in-flight step retries.

- **"No ingress, no webhooks, no /api/inngest route."** The worker connects
  outbound over WebSocket via Inngest Connect. Deploy it anywhere that can
  make an outbound connection.

- **"Your serverless web app never calls the model."** Next.js only sends
  events and mints subscription tokens. All model traffic lives in the
  worker.

- **"Swap the model, not the code."** One OpenRouter key covers everything;
  `MODEL_A` / `MODEL_B` point the experiment at any two models OpenRouter
  serves — the agent loop, tools, and streaming don't change.

- **"The model writes Python. The sandbox runs it. It's still just a step."**
  A `run_python` tool executes model-written scripts in a secure in-process
  interpreter (Monty) — no filesystem, network, or env access — and the
  whole call is one memoized `tool-run_python-*` step like any other.

**Accuracy guardrails** (keep copy honest):

- Say steps are **"replayed from memory"** or **"not re-executed"** — the
  function body does re-enter on retry; the completed steps' *work* doesn't
  re-run. Avoid "never runs again" phrasing about code.
- The number of steps is unknown upfront, but step **IDs** are deterministic
  on replay (loop index + tool order) — that's *why* memoization works.
  Don't claim "random steps" or "any shape"; say dynamic-but-reproducible.

---

## Proof points

| Claim | Where |
| --- | --- |
| One durable step per LLM turn | `src/worker/agent.ts` — `step.run("llm-turn-${turn}")` in `streamTurn` |
| One durable step per tool call | `src/worker/agent.ts` — `step.run("tool-${name}-${turn}-${i}")` |
| Steps created in a runtime loop | `src/worker/agent.ts` — `for (let turn = 0; turn < MAX_TURNS; turn++)` |
| Token streaming is non-durable by design | `inngest.realtime.publish(ch.tokens, ...)` (client-level, not memoized) |
| Status events are durable steps | `step.realtime.publish("turn-completed-${turn}", ...)` |
| Retry re-streams from `seq: 0`; UI resets | Design notes in `README.md` — "`seq: 0` replay semantics" |
| Outbound-only worker, no serve route | `src/worker/index.ts` — `connect({ apps: [...] })` |
| Web app never executes a step | `src/app/api/chat/route.ts`, `src/app/api/realtime-token/route.ts` |
| Any two models, one OpenRouter key | `src/worker/openrouter.ts`, `MODEL_A`/`MODEL_B` in `src/worker/chat-function.ts` |
| Python tool runs in a secure sandbox, as a step | `src/worker/sandbox/` (Monty runner), `tool-run_python-*` in `src/worker/agent.ts` |

---

## Demo script (60 seconds)

1. **Open the deployed app.** Click the first suggestion, *"Three-city weather
   report"*:
   *"Build a full weather report on Tokyo, Oslo, and Nairobi. Fetch all three,
   then use Python to compute each city's average high, average low, and total
   rainfall. Then run a second Python pass comparing the first and last two
   weeks to see which cities are warming. Convert the single hottest reading to
   Fahrenheit, check the local time in each city, and finish with a ranked
   summary table."*
2. **Watch the stream:** tokens appear live; the agent fetches all three
   cities, then writes Python scripts — tool-call lines interrupt the stream,
   each script runs in the Monty sandbox (marked **Sandboxed** in the UI), and
   its source + printed output render as code blocks in the trace.
3. **Open the Inngest dashboard** (AI → Runs) and point at the run view:
   `llm-turn-0`, `tool-get_weather_multi-0-0`, `llm-turn-1`,
   `tool-run_python-1-0`, `llm-turn-2`, `tool-run_python-2-0`, …,
   `tool-convert_to_fahrenheit-*`, `tool-get_current_time-*` — each a discrete,
   individually-addressable step, none of them declared in advance.
4. **The money shot:** kill the worker during the second Python pass. "Every
   one of those boxes is a checkpoint. The run resumes with exactly one step
   redone — everything else replays from memory."
5. **Send a follow-up** (*"now add London to the report"*) to show full
   conversation history round-tripping.

### Long-running demo prompts

Each names its steps so the model chains 5+ durable steps (the suggestion
cards in the UI use these verbatim):

- **Three-city weather report** — the demo prompt above.
- **Pick a trip destination** — *"I'm choosing between Lisbon, Barcelona, and
  Athens. Fetch their weather, use Python to score each on warmth, dryness, and
  calm wind, then rerun the scoring with dryness weighted double and tell me
  whether the winner changes. Check the local time in each, and recommend one
  with a comparison table."*
- **Five-city showdown** — *"Compare Tokyo, London, New York, Sydney, and Cape
  Town. Fetch them all, use Python to find each city's hottest and wettest day,
  then run a separate Python analysis of how humidity relates to rainfall in
  each city. Convert every city's average high to Fahrenheit, and summarize the
  three most surprising findings."*

---

## Taglines

- Durable execution at the speed of streaming.
- The agent runs forever. You watch it live.
- Steps you didn't plan, retried like you did.
