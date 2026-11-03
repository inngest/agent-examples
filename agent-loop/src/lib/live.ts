// Live updates for `pnpm goal:watch` from the attempts. Each turn is published
// in one step, so a replay never re-sends it, and a realtime outage is
// swallowed inside the step: the watcher is a viewer, and must never fail or
// retry an attempt.
import { step } from "inngest";
import type { AgentTurn } from "inngest/experimental/agents";
import { inngest } from "../inngest/client.js";
import { excerpt, goalChannel, type AttemptMessage } from "../inngest/channel.js";

/** An `onTurn` that shows attempt `i`'s turn and its tool calls, in one step per turn. */
export const liveTurns =
  (goalId: string, i: number) =>
  async ({ turn: t, stepId, text, runs, usage, model }: AgentTurn): Promise<void> => {
    await step.run(`live-${stepId}`, async () => {
      const messages: AttemptMessage[] = [
        {
          type: "turn",
          i,
          t,
          toolCalls: runs.length,
          finishReason: String(model?.finishReason ?? ""),
          text: excerpt(text),
          outputTokens: usage.output,
          inputTokens: usage.input,
          reasoningTokens: (model?.reasoningTokens as number | null) ?? undefined,
          maxTokens: model?.maxTokens as number | undefined,
          reasoningOff: model?.reasoningOff as boolean | undefined,
          blank: model?.blank as boolean | undefined,
          provider: (model?.provider as string | null) ?? undefined,
        },
      ];
      for (const [n, run] of runs.entries()) {
        if (run.name === "work_finish" && run.isError) messages.push({ type: "finish.refused", i, t });
        messages.push({ type: "tool", i, t, n: n + 1, name: run.name, result: excerpt(String(run.output), 120) });
      }
      for (const message of messages) {
        await inngest.realtime.publish(goalChannel(goalId).attempt, message).catch(() => {});
      }
      return null;
    });
  };
