import { createScorer } from "inngest/experimental";
import { z } from "zod";
import { inngest } from "./client";

// A deferred scorer: a separate function run enqueued when record-message
// finalizes. It waits for the user to click 👍/👎 in the UI (matched by
// messageId), then returns a score that attaches to the originating
// record-message run. If the click never arrives within the timeout, it
// returns null — recording nothing rather than a fake default.
export const feedbackScorer = createScorer(
  inngest,
  {
    id: "feedback-scorer",
    schema: z.object({ messageId: z.string() }),
  },
  async ({ event, step }) => {
    const feedback = await step.waitForEvent("wait-for-feedback", {
      event: "chat/feedback.clicked",
      timeout: "1d",
      if: `async.data.messageId == '${event.data.messageId}'`,
    });

    if (!feedback) return null;

    return {
      name: "thumbs-up",
      value: feedback.data.up ? 1 : 0,
    };
  },
);
