// Probe (Finding 22 follow-up): the Inngest Experiments dashboard shows no
// variant data for the demo run even though every step.score() is called
// inside the selected variant callback, which the docs say is sufficient.
// SDK 4.18.1 source shows step.score() writes only {runId, stepId} + value
// ("inngest.score" metadata), while inngest.score.experiment() additionally
// writes an "inngest.experiment" metadata op {name, variant} — the likely
// attribution marker the dashboard joins on. This function exercises BOTH
// mechanisms side by side and records its run ID so the stored payload can
// be inspected via GET /v1/runs/{id}.
import { writeFileSync } from "node:fs";
import { experiment } from "inngest";
import { inngest } from "./client";
import { EVENTS } from "./events";

const OUT = "/var/folders/y5/f387nwbs1p56fm4bs8jf1n600000gn/T/opencode/omt-probe-run-id";

export const probeExperiment = inngest.createFunction(
  { id: "probe-experiment", retries: 0, triggers: [{ event: EVENTS.probeExperiment }] },
  async ({ event, step, runId, group }) => {
    await step.run("record-run-id", () => {
      writeFileSync(OUT, String(runId));
      return runId;
    });

    // Mechanism A (what the demo run uses): step.score() inside the variant.
    // Mechanism B: inngest.score.experiment() with the experimentRef, after.
    const { result, variant, experimentRef } = await group.experiment("model-faceoff", {
      variants: {
        a: async () => {
          await step.run("variant-work", () => 1);
          await step.score("score-in-variant", { name: "probe-in-variant", value: 42 });
          return 1;
        },
      },
      select: experiment.fixed("a"),
    });

    await step.run("explicit-experiment-score", async () => {
      await inngest.score.experiment({
        name: "probe-explicit",
        value: 7,
        experiment: experimentRef,
      });
    });

    return { result, variant };
  },
);
