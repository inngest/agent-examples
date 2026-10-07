// Live updates for `pnpm goal:watch`. Each publish is its own memoized step,
// so a replay never re-sends it, and a realtime outage is swallowed inside
// the step: the watcher is a viewer, and must never fail or retry the goal.
import { inngest } from "../inngest/client.js";
import { goalChannel, type AttemptMessage, type LoopMessage } from "../inngest/channel.js";

type RunStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>;
};

const publish = (step: RunStep, id: string, send: () => Promise<void>) =>
  step.run(id, async () => {
    await send().catch(() => {});
    return null;
  });

export const liveLoop = (step: RunStep, id: string, goalId: string, msg: LoopMessage) =>
  publish(step, id, () => inngest.realtime.publish(goalChannel(goalId).loop, msg));

export const liveAttempt = (step: RunStep, id: string, goalId: string, msg: AttemptMessage) =>
  publish(step, id, () => inngest.realtime.publish(goalChannel(goalId).attempt, msg));

// Not a step: for use inside a step that already runs once (a tool call).
export const liveAttemptInStep = (goalId: string, msg: AttemptMessage) =>
  inngest.realtime.publish(goalChannel(goalId).attempt, msg).catch(() => {});
