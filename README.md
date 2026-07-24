# Inngest agent examples

Runnable, self-contained examples of building durable AI agents with
[Inngest](https://www.inngest.com). Each example lives in its own directory with
its own README and setup.

## Examples

| Example | What it shows |
|---|---|
| [`durable-agent/`](./durable-agent) | Durable, exactly-once tool execution for an agent that charges a credit card. A fragile inline agent loop next to the same agent made crash-safe with Inngest steps — run both to feel the difference. |
| [`docs-understanding-agent/`](./docs-understanding-agent) | A GitHub-webhook-triggered agent that reviews docs PRs for AI-answer-engine readability, running multiple model variants (experiment mode) and posting scored feedback as a check run and PR comment. |
| [`token-streaming-agent/`](./token-streaming-agent) | Streaming an agent's LLM tokens live to a browser with Inngest Realtime, while the agent itself runs as a durable function in a long-lived Connect worker — no custom SSE/WebSocket route, no `/api/inngest` serve endpoint. |
