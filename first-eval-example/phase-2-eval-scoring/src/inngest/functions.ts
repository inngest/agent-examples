import { experiment } from "inngest";
import { inngest } from "./client";
import { feedbackScorer } from "./scorers";
import { chat, DEFAULT_MODEL, CANDIDATE_MODEL } from "../openrouter";
import { deliverReply } from "../reply-bus";

export const recordMessage = inngest.createFunction(
  { id: "record-message", triggers: { event: "chat/message.requested" } },
  async ({ event, step, defer, group }) => {
    const { result: reply, variant, experimentRef } = await group.experiment("chat-model", {
      variants: {
        control: () => step.run("call-model-control", () => chat(event.data.prompt, DEFAULT_MODEL)),
        candidate: () => step.run("call-model-candidate", () => chat(event.data.prompt, CANDIDATE_MODEL)),
      },
      select: experiment.weighted({ control: 50, candidate: 50 }),
    });

    defer("score-feedback", {
      function: feedbackScorer,
      data: { messageId: event.data.messageId },
      experiment: experimentRef,
    });

    // Hand the reply to the HTTP request waiting in this same process (see
    // src/reply-bus.ts) — Inngest Cloud's REST API doesn't expose run output,
    // so the HTTP handler can't poll for it. Idempotent across memoization
    // passes: only the first delivery resolves the waiter.
    deliverReply(event.data.messageId, { reply, variant });

    return { reply, variant };
  },
);
