import { inngest } from "./client";
import { upsertSample, upsertScore } from "../db";

// A dedicated function that owns every DuckDB write. concurrency: 1 makes it
// a global single-writer lock across BOTH event types — splitting sample and
// score capture into two separate functions (even if each also had
// concurrency: 1) would let one of each run at the same time and still race
// on the same DuckDB file.
export const captureDataset = inngest.createFunction(
  { id: "capture-dataset", concurrency: 1, triggers: [{ event: "dataset/sample.captured.v3" }, { event: "dataset/score.captured.v3" }] },
  async ({ event, step }) => {
    if (event.name === "dataset/sample.captured.v3") {
      await step.run("upsert-sample", () =>
        upsertSample({
          runId: event.data.runId,
          conversation: event.data.messages,
          reply: event.data.reply,
          variant: event.data.variant,
          model: event.data.model,
          latencyMs: event.data.latencyMs,
          messageId: event.data.messageId,
          conversationId: event.data.conversationId,
        }),
      );
      return;
    }

    await step.run("upsert-score", () =>
      upsertScore({
        runId: event.data.runId,
        name: event.data.name,
        value: event.data.value,
        source: event.data.source,
      }),
    );
  },
);
