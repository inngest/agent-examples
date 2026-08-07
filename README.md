# Inngest agent examples

Runnable, self-contained examples of building durable AI agents with
[Inngest](https://www.inngest.com). Each example lives in its own directory with
its own README and setup.

## Examples

| Example | What it shows |
|---|---|
| [`durable-agent/`](./durable-agent) | Durable, exactly-once tool execution for an agent that charges a credit card. A fragile inline agent loop next to the same agent made crash-safe with Inngest steps — run both to feel the difference. |
| [`token-streaming-agent/`](./token-streaming-agent) | Streaming an agent's LLM tokens live to a browser with Inngest Realtime, while the agent itself runs as a durable function in a long-lived Connect worker — no custom SSE/WebSocket route, no `/api/inngest` serve endpoint. |
| [`first-eval-example/`](./first-eval-example) | A three-phase webinar walkthrough: a basic durable agent that calls a model via OpenRouter (phase 1), a chat UI with 👍/👎 captured by a deferred scorer that attaches a `thumbs-up` score to each reply's run (phase 2), then a multiturn support-ticket triage bot scored eight ways by an LLM-as-judge plus human feedback, with a golden dataset exported for a fine-tune demo (phase 3). |
