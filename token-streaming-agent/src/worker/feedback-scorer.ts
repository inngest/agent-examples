import { createScorer } from "inngest/experimental";
import { z } from "zod";
import { inngest } from "../inngest/client";

// A deferred scorer: unlike the in-run judges in chat-function.ts, a 👍/👎
// only arrives *after* the chat run has finished, when a real user clicks it.
// `defer(...)` (see chat-function.ts) enqueues this scorer when the chat run
// finalizes; it then parks on `step.waitForEvent` until the matching feedback
// event shows up (or the timeout lapses). Its return value is attributed back
// to the run — and, via the `experiment` ref passed to `defer`, to that run's
// experiment variant — so haiku vs opus become comparable by human feedback
// alongside the automated scores.
export const feedbackScorer = createScorer(
  inngest,
  {
    id: "feedback-scorer",
    // `data` passed to `defer(...)` is validated against this and surfaces as
    // the handler's `event.data`. `eventId` is the chat run's triggering event
    // id (returned to the browser by /api/chat), which the feedback event
    // carries back so a rating lands on the exact response that produced it.
    schema: z.object({ eventId: z.string() }),
  },
  async ({ event, step }) => {
    const feedback = await step.waitForEvent("wait-for-feedback", {
      event: "chat/feedback.received",
      // Users rate on their own schedule (or never).
      timeout: "1d",
      if: `async.data.eventId == '${event.data.eventId}'`,
    });

    // No rating within the window → record nothing. A nullish return is a
    // no-op for the scorer, so unrated responses never dilute the metric —
    // only real 👍/👎 count.
    if (!feedback) return;

    return { name: "user-feedback", value: feedback.data.helpful ? 1 : 0 };
  },
);
