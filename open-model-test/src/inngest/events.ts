import { z } from "zod";

// Event names follow the repo convention: domain/action.requested (+ .completed).

export const EVENTS = {
  runRequested: "benchmark/run.requested",
  sampleRequested: "benchmark/task.sample.requested",
  sampleCompleted: "benchmark/sample.completed",
  runCompleted: "benchmark/run.completed",
} as const;

export const RunRequestedSchema = z
  .object({
    // Optional — the API handler pre-generates it so POST /api/run can return
    // it immediately; orchestrate-run generates one when absent.
    runId: z.string().regex(/^[a-zA-Z0-9-]+$/).optional(),
  })
  .strict();

export const SampleRequestedSchema = z
  .object({
    runId: z.string().min(1),
    modelId: z.string().min(1),
    taskId: z.string().min(1),
    sample: z.number().int().min(0),
    seed: z.number().int().optional(),
  })
  .strict();

export const SampleCompletedSchema = z
  .object({
    runId: z.string().min(1),
    modelId: z.string().min(1),
    taskId: z.string().min(1),
    sample: z.number().int().min(0),
  })
  .strict();

export const RunCompletedSchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();
