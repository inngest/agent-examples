import { experiment } from "inngest";
import { inngest } from "../inngest/client";
import { runChatAgent } from "./agent";
import {
  scoreConciseness,
  scoreHelpfulness,
  scoreToolEfficiency,
  scoreToolCallValidity,
  scoreToolUseCorrectness,
  scorePythonCodeQuality,
} from "./scorers";
import { feedbackScorer } from "./feedback-scorer";
import { chatChannel, type ChatMessage } from "../inngest/channel";

// The two experiment arms, A and B — all env-driven so any pair of OpenRouter
// models can be swapped in without touching code. Both run through the same
// OpenRouter client (see worker/openrouter.ts); the per-model context window
// feeds the UI's context meter and is overridable for whatever models you point
// A/B at (the defaults match the out-of-the-box slugs).
const MODEL_A = process.env.MODEL_A ?? "anthropic/claude-sonnet-5";
const MODEL_B = process.env.MODEL_B ?? "nvidia/nemotron-3-ultra-550b-a55b";
const MODEL_A_CONTEXT_WINDOW = Number(process.env.MODEL_A_CONTEXT_WINDOW) || 1_000_000;
const MODEL_B_CONTEXT_WINDOW = Number(process.env.MODEL_B_CONTEXT_WINDOW) || 512_000;

export const chatFn = inngest.createFunction(
  {
    id: "weather-agent",
    triggers: [{ event: "chat/message.sent" }],
    // Retry the whole run up to 3 times. Steps memoize, so a retry replays
    // completed turns/tools for free and only re-runs from the step that
    // failed — the model isn't re-billed for turns that already finished.
    retries: 3,
    // Durable cancellation: a Stop click sends `chat/cancel.requested`; Inngest
    // tears this run down at the next step boundary when the cancel event's
    // sessionId matches this run's. `async` is the cancel event, `event` the
    // original `chat/message.sent` trigger.
    cancelOn: [{ event: "chat/cancel.requested", if: "async.data.sessionId == event.data.sessionId" }],
    // Terminal failure notice: fires exactly once, only after all retries are
    // exhausted. This is why agent.ts no longer publishes `run.failed` from its
    // catch — that fired on every attempt, so a transient error would surface a
    // permanent failure the client committed before a retry could succeed.
    onFailure: async ({ event, error }) => {
      // The failed event wraps the original trigger at `event.data.event`.
      const sessionId = (event.data.event.data as { sessionId?: string })?.sessionId;
      if (!sessionId) return;
      await inngest.realtime
        .publish(chatChannel(sessionId).status, { type: "run.failed", error: error.message })
        .catch(() => {});
    },
  },
  async ({ event, step, group, defer, logger, runId }) => {
    const { sessionId, messages } = event.data as { sessionId: string; messages: ChatMessage[] };
    logger.info("chat-agent: run start", { runId, eventId: event.id, sessionId });

    // Bucket by session so one conversation sticks with one model, and score
    // each run so the two arms become comparable in the dashboard. The arms are
    // named generically (a/b) so swapping the models behind MODEL_A / MODEL_B
    // needs no renaming here; the raw slug is what surfaces in the UI.
    const { result, variant, experimentRef } = await group.experiment("weather-chat-bot", {
      variants: {
        a: () => runChatAgent(step, sessionId, messages, MODEL_A, MODEL_A_CONTEXT_WINDOW, MODEL_A, logger),
        b: () => runChatAgent(step, sessionId, messages, MODEL_B, MODEL_B_CONTEXT_WINDOW, MODEL_B, logger),
      },
      select: experiment.bucket(sessionId, { weights: { a: 50, b: 50 } }),
    });

    logger.info("chat-agent: run done", { runId, variant, toolCalls: result.toolCalls.length });

    // Deferred scoring: a 👍/👎 only arrives after this run finishes, so it
    // can't be written inline like the judges below. `defer` enqueues the
    // feedback scorer when this run finalizes; it parks on a `waitForEvent`
    // keyed by this run's triggering event id (`event.id`, the same id
    // /api/chat returns to the browser) and, if a rating lands, attaches a
    // `user-feedback` score to this run's experiment variant. Fire-and-forget:
    // it runs as its own function and can't affect the chat run.
    defer("score-user-feedback", {
      function: feedbackScorer,
      data: { eventId: event.id! },
      experiment: experimentRef,
    });

    // Scoring is best-effort: the chat text was already streamed/published by
    // runChatAgent, so a scoring failure (a flaky judge call, a rate limit)
    // must never surface as a failed chat run.
    try {
      // ChatMessage's content can now be a tool_result block array too (a
      // tool_result message also has role "user"), so the judge prompt must
      // specifically find the last user turn that's plain text, not just the
      // last user-role message.
      const prompt =
        (messages.findLast((m) => m.role === "user" && typeof m.content === "string")?.content as
          | string
          | undefined) ?? "";

      // Written independently of the judges below: these scores are
      // deterministic and can't fail, so a judge hiccup must not drop them too.
      // Must run at function-body level (not inside step.run) so each write is
      // run-scoped and attaches to the experiment.
      const toolEfficiency = scoreToolEfficiency(result.toolCalls);
      await inngest.score.experiment({
        name: toolEfficiency.name,
        value: toolEfficiency.value,
        experiment: experimentRef,
      });

      // Tool-emit quality: how well the model formed the calls it emitted
      // (parseable args + required fields). Skipped (null) when no tools were
      // called, so it reflects emit quality only where calls happened.
      const toolValidity = scoreToolCallValidity(result.toolCalls);
      if (toolValidity) {
        await inngest.score.experiment({
          name: toolValidity.name,
          value: toolValidity.value,
          experiment: experimentRef,
        });
      }

      // Run the judge calls independently (allSettled, not Promise.all) so one
      // judge failing doesn't drop the others. scoreToolUseCorrectness is the
      // judge-side companion to the deterministic tool scores — it catches
      // needed tools the model skipped or wrong tools it called.
      const judgments = await Promise.allSettled([
        scoreConciseness(step, prompt, result.text),
        scoreHelpfulness(step, prompt, result.text),
        scoreToolUseCorrectness(step, prompt, result.toolCalls),
        // Grades the Python the model wrote via run_python (skips when none ran).
        scorePythonCodeQuality(step, prompt, result.newMessages),
      ]);

      for (const outcome of judgments) {
        if (outcome.status === "rejected") {
          console.error("chat-agent: judge scoring failed", outcome.reason);
          continue;
        }
        const s = outcome.value;
        if (!s) continue;
        await inngest.score.experiment({ name: s.name, value: s.value, experiment: experimentRef });
      }
    } catch (err) {
      console.error("chat-agent: scoring failed", err);
    }

    // `newMessages` is returned so the browser can recover the reply (and keep
    // its tool context) via the catch-up route (api/run-status) when a realtime
    // `run.completed` is missed — e.g. a dropped connection or a mid-run reload.
    // `model` (the resolved slug) rides along so the recovered model badge shows
    // the real model name, not just the experiment variant key.
    return {
      text: result.text,
      variant,
      model: variant === "a" ? MODEL_A : MODEL_B,
      newMessages: result.newMessages,
    };
  },
);
