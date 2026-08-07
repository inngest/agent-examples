# First Eval Example — basic agent + human-feedback scoring

A three-phase webinar walkthrough: build the smallest possible durable agent
with [Inngest](https://www.inngest.com), add a chat UI with 👍/👎 whose
ratings are captured by a deferred scorer, then grow into a support-ticket
triage bot scored by an LLM-as-judge and a golden fine-tune dataset. The model
comes from [OpenRouter](https://openrouter.ai) via the official `openai` SDK.

## The three phases

| | |
|---|---|
| [`phase-1-basic-agent/`](./phase-1-basic-agent) | One Inngest function, one durable `step.run` around the OpenRouter call. The smallest "durable agent that calls a model" worth showing. |
| [`phase-2-eval-scoring/`](./phase-2-eval-scoring) | A chat UI where each reply gets 👍/👎. A deferred scorer waits for the click and attaches a `thumbs-up` score to the run that produced the reply. |
| [`phase-3-multiturn-evals/`](./phase-3-multiturn-evals) | A support-ticket triage bot: strict-JSON replies (`category`/`urgency`/`sentiment`/`suggested_reply`), scored eight ways per reply — 2 inline heuristics (`valid-json`, `latency-ms`) + 1 human 👍/👎 + 5 LLM-judge scores (`category-correct`, `urgency-correct`, `sentiment-correct`, `reply-quality`, `context-awareness`). Captures a golden dataset in DuckDB and exports it (`bun run export`) as OpenAI chat-SFT JSONL for a fine-tune demo. |

## Quick start (each phase)

Each phase is a standalone [Bun](https://bun.sh) project. From a phase
directory:

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

**Trigger a run:**

```sh
bun run agent
```

Open the Dev Server, find the **Runs** tab, and click into the run to watch
each step execute. That `bun run agent` trigger applies to phase 1 only —
phase 2 and phase 3 each have a browser chat UI at http://localhost:3000;
open that instead of using `bun run agent`.

## What you'll see

- **Phase 1** — a single `call-model` step with the model's reply.
- **Phase 2** — a `record-message` run that defers a `feedback-scorer` run.
  The scorer parks on `wait-for-feedback` until you click 👍/👎, then attaches
  a `thumbs-up` score (1 or 0) to the `record-message` run. Unrated messages
  time out after 1 day and record nothing.
- **Phase 3** — the same chat pattern, but each reply is a strict-JSON triage
  card (category/urgency/sentiment badges + suggested reply) instead of free
  text, and carries eight scores instead of one: the two inline heuristics
  and the human 👍/👎 from phase 2, plus five LLM-judge scores from a deferred
  judge run. Every scored sample also flows into a DuckDB golden dataset that
  `bun run export` turns into fine-tune-ready JSONL.

Phase 2 and phase 3 also split the model call itself: each run is a 50/50
`group.experiment` between a control model (`OPENROUTER_MODEL`) and a
candidate model (`OPENROUTER_MODEL_CANDIDATE`). The deferred 👍/👎 score
attaches to whichever variant was selected, so the two models show up as
comparable variants in Inngest's experiment view.

Run `bun run populate` alongside `bun run dev` to generate synthetic traffic
and 👍/👎 feedback in the background, so the experiment view fills up with
scores without you clicking through the UI by hand — phase 2 plays synthetic
chat messages, phase 3 plays back ~20 scripted triage scenarios. Phase 3 also
has `bun run export`, which reads the golden dataset out of DuckDB and writes
`data/golden.jsonl` for the fine-tune demo (see its README).

## Docs

- [Inngest Next.js quick start](https://www.inngest.com/docs/getting-started/nextjs-quick-start)
- [Build a deferred scorer](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring)
- [Score a function run](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/scoring)
