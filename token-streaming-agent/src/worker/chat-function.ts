import { experiment } from "inngest";
import { inngest } from "../inngest/client";
import { runChatAgent } from "./agent";
import { scoreConciseness, scoreHelpfulness, scoreToolEfficiency } from "./scorers";
import type { ChatMessage } from "../inngest/channel";

const HAIKU = process.env.MODEL_HAIKU ?? "claude-haiku-4-5";
const OPUS = process.env.MODEL_OPUS ?? "claude-opus-4-8";

export const chatFn = inngest.createFunction(
  { id: "chat-agent", triggers: [{ event: "chat/message.sent" }] },
  async ({ event, step, group }) => {
    const { sessionId, messages } = event.data as { sessionId: string; messages: ChatMessage[] };

    // Bucket by session so one conversation sticks with one model, and
    // score each run so the two variants become comparable in the dashboard.
    const { result, variant, experimentRef } = await group.experiment("chat-model", {
      variants: {
        haiku: () => runChatAgent(step, sessionId, messages, HAIKU),
        opus: () => runChatAgent(step, sessionId, messages, OPUS),
      },
      select: experiment.bucket(sessionId, { weights: { haiku: 50, opus: 50 } }),
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

      // Written independently of the judges below: this score is
      // deterministic and can't fail, so a judge hiccup must not drop it too.
      const toolEfficiency = scoreToolEfficiency(result.toolCalls);
      // Must run at function-body level (not inside step.run) so the write
      // is run-scoped and attaches to the experiment.
      await inngest.score.experiment({
        name: toolEfficiency.name,
        value: toolEfficiency.value,
        experiment: experimentRef,
      });

      // Run the two judge calls independently (allSettled, not Promise.all)
      // so one judge failing doesn't drop the other's score.
      const judgments = await Promise.allSettled([
        scoreConciseness(step, prompt, result.text),
        scoreHelpfulness(step, prompt, result.text),
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

    return { text: result.text, variant };
  },
);
