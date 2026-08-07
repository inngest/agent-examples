import { experiment } from "inngest";
import { inngest } from "./client";
import { feedbackScorer, judgeScorer } from "./scorers";
import { chat, DEFAULT_MODEL, CANDIDATE_MODEL } from "../openrouter";
import { deliverReply } from "../reply-bus";
import { parseTriage } from "../triage";

export const recordMessage = inngest.createFunction(
  // The ".v3" event suffix matters: phase 2 and phase 3 share one Inngest
  // Cloud environment, and phase 2's record-message also triggers on
  // "chat/message.requested". Without distinct names, one event spawns a run
  // in BOTH apps — and the phase-2 run just hangs whenever that worker is
  // offline, confusing anything that polls the event's runs.
  { id: "record-message", triggers: { event: "chat/message.requested.v3" } },
  async ({ event, step, defer, group, runId }) => {
    const { result, variant, experimentRef } = await group.experiment("chat-model-v3", {
      variants: {
        control: () =>
          step.run("call-model-control", async () => {
            const t0 = performance.now();
            const reply = await chat(event.data.messages, DEFAULT_MODEL);
            return { reply, latencyMs: Math.round(performance.now() - t0) };
          }),
        candidate: () =>
          step.run("call-model-candidate", async () => {
            const t0 = performance.now();
            const reply = await chat(event.data.messages, CANDIDATE_MODEL);
            return { reply, latencyMs: Math.round(performance.now() - t0) };
          }),
      },
      select: experiment.weighted({ control: 50, candidate: 50 }),
    });

    const { reply, latencyMs } = result;

    // Cheap deterministic metrics computed inline, at function-body level, so
    // they land on the dashboard immediately with the run — unlike the
    // deferred LLM-judge and human-feedback scores below, these don't need a
    // separate run or an external event to produce a value.
    // Best-effort: the reply is already computed, so a transient failure
    // writing a metric must not fail the run (and turn a good reply into a
    // 502 on /api/chat). Losing a heuristic data point is the cheaper loss.
    const validJson = parseTriage(reply) ? 1 : 0;
    try {
      await inngest.score.experiment({ name: "valid-json", value: validJson, experiment: experimentRef });
      await inngest.score.experiment({ name: "latency-ms", value: latencyMs, experiment: experimentRef });
    } catch (err) {
      console.warn(`inline score write failed: ${err}`);
    }

    defer("score-feedback", {
      function: feedbackScorer,
      data: { messageId: event.data.messageId },
      experiment: experimentRef,
    });

    defer("score-judge", {
      function: judgeScorer,
      data: { messages: event.data.messages, reply },
      experiment: experimentRef,
    });

    // Hand the reply to the HTTP request waiting in this same process (see
    // src/reply-bus.ts) — Inngest Cloud's REST API doesn't expose run output,
    // so the HTTP handler can't poll for it. Idempotent across memoization
    // passes: only the first delivery resolves the waiter.
    deliverReply(event.data.messageId, { reply, variant });

    // Fire-and-forget capture of this sample + its two inline scores into the
    // golden-dataset pipeline (src/inngest/capture.ts writes them to DuckDB).
    // Sent as one batch so a single step retry can't leave sample and scores
    // arriving as separate at-least-once deliveries with different retry timing.
    await step.sendEvent("capture-dataset", [
      {
        name: "dataset/sample.captured.v3",
        data: {
          runId,
          messages: event.data.messages,
          reply,
          variant,
          model: variant === "candidate" ? CANDIDATE_MODEL : DEFAULT_MODEL,
          latencyMs,
          messageId: event.data.messageId,
          conversationId: event.data.conversationId,
        },
      },
      {
        name: "dataset/score.captured.v3",
        data: { runId, name: "valid-json", value: validJson, source: "inline" },
      },
      {
        name: "dataset/score.captured.v3",
        data: { runId, name: "latency-ms", value: latencyMs, source: "inline" },
      },
    ]);

    return { reply, variant };
  },
);
