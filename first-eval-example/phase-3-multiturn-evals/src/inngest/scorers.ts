import { createDefer, createScorer } from "inngest/experimental";
import { z } from "zod";
import { inngest } from "./client";
import { judge } from "../openrouter";

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
  async ({ event, step, parents }) => {
    const feedback = await step.waitForEvent("wait-for-feedback", {
      event: "chat/feedback.clicked.v3",
      timeout: "1d",
      if: `async.data.messageId == '${event.data.messageId}'`,
    });

    if (!feedback) return null;

    const value = feedback.data.up ? 1 : 0;

    // Best-effort, same discipline as the inline scores in functions.ts: the
    // primary thumbs-up score is only recorded via this handler's *return
    // value*, so if this capture send were allowed to fail the run, a
    // dataset-pipeline hiccup would erase the user's actual click. Losing one
    // DuckDB row is the cheaper loss.
    try {
      await step.sendEvent("capture-dataset-score", {
        name: "dataset/score.captured.v3",
        data: { runId: parents[0].runId, name: "thumbs-up", value, source: "feedback" },
      });
    } catch (err) {
      console.warn(`dataset capture send failed: ${err}`);
    }

    return { name: "thumbs-up", value };
  },
);

// A deferred LLM-as-judge scorer: a separate function run enqueued when
// record-message finalizes, alongside feedbackScorer. It runs one judge()
// call and fans the single verdict out into five named scores, all attached
// to the originating record-message run and its experiment variant. That
// fan-out is exactly why this is `createDefer` + `inngest.score(...)` rather
// than `createScorer` — createScorer's handler returns (and therefore
// records) only one `{name, value}` per run, but one judge call here needs to
// produce five independently-aggregating scores (category-correct,
// urgency-correct, sentiment-correct, reply-quality, context-awareness).
export const judgeScorer = createDefer(
  inngest,
  {
    id: "judge-scorer",
    schema: z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() })),
      reply: z.string(),
    }),
  },
  async ({ event, step, parents }) => {
    const verdict = await step.run("judge", () => judge(event.data.messages, event.data.reply));

    const { runId, experiment } = parents[0];

    const scores: Array<{ name: string; value: number }> = [
      { name: "category-correct", value: verdict.categoryCorrect ? 1 : 0 },
      { name: "urgency-correct", value: verdict.urgencyCorrect ? 1 : 0 },
      { name: "sentiment-correct", value: verdict.sentimentCorrect ? 1 : 0 },
      { name: "reply-quality", value: verdict.replyQuality },
      { name: "context-awareness", value: verdict.contextAwareness },
    ];

    for (const { name, value } of scores) {
      if (experiment) {
        await inngest.score.experiment({ runId, experiment, name, value });
      } else {
        await inngest.score({ runId, name, value });
      }
    }

    // Same golden-dataset capture as the other scorers: fan the five judge
    // scores out as one batch to capture-dataset (src/inngest/capture.ts),
    // which writes them to DuckDB independently of the inngest.score(...)
    // calls above. Best-effort: the primary scores are already written, and a
    // capture failure must not fail (and therefore retry) this run over a
    // missing DuckDB row.
    try {
      await step.sendEvent(
        "capture-dataset-scores",
        scores.map(({ name, value }) => ({
          name: "dataset/score.captured.v3",
          data: { runId, name, value, source: "judge" },
        })),
      );
    } catch (err) {
      console.warn(`dataset capture send failed: ${err}`);
    }

    return verdict;
  },
);
