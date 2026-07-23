import { createScorer } from "inngest/experimental";
import { z } from "zod";
import { inngest } from "./client";

// One scorer run is deferred per analyzed page. All of them park on the same
// PR-level feedback event (matched by sha), so a single reviewer click on the
// check run resolves every page's scorer — each attributing the verdict to its
// own page's experiment variant via the `experiment` ref passed to defer().
export const reviewerFeedbackScorer = createScorer(
  inngest,
  {
    id: "reviewer-feedback",
    schema: z.object({
      sha: z.string().regex(/^[0-9a-f]{7,40}$/i),
      owner: z.string(),
      repo: z.string(),
      route: z.string(),
      variant: z.string(),
    }),
  },
  async ({ event, step }) => {
    const feedback = await step.waitForEvent("wait-for-review", {
      event: "github/review.feedback",
      timeout: "7d",
      if: `async.data.sha == "${event.data.sha}"`,
    });

    if (!feedback) return null; // reviewer never clicked — record nothing

    return {
      name: "reviewer-approval",
      value: feedback.data.verdict === "approve",
    };
  },
);
