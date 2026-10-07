// Sends goal/started. Shared by `pnpm goal:send` and `pnpm goal:watch`.
// Targets the dev server or Inngest Cloud depending on env (INNGEST_DEV=1 vs
// INNGEST_EVENT_KEY).
import { inngest } from "../inngest/client.js";
import { goalStarted } from "../inngest/events.js";

export type GoalOptions = {
  goalId: string;
  model?: string;
  maxAttempts?: number;
  maxStalls?: number;
  maxTokensPerTurn?: number;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningMaxTokens?: number;
  focus?: boolean;
};

// The goal flags both scripts accept: --model, --max-attempts, --max-stalls,
// --max-tokens, --reasoning-effort low|medium|high, --reasoning-max-tokens,
// --no-focus (attempts see the whole report instead of one function).
export function parseGoalArgs(argv: string[]): Partial<GoalOptions> {
  const args = argv.filter((a) => a !== "--");
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const num = (flag: string) => {
    const v = get(flag);
    return v === undefined ? undefined : Number(v);
  };
  return {
    goalId: get("--goal"),
    // Unset → the worker resolves MODEL from its own env (or DEFAULT_MODEL).
    model: get("--model") ?? (process.env.MODEL || undefined),
    maxAttempts: num("--max-attempts"),
    maxStalls: num("--max-stalls"),
    maxTokensPerTurn: num("--max-tokens"),
    reasoningEffort: (["low", "medium", "high"] as const).find((e) => e === get("--reasoning-effort")),
    reasoningMaxTokens: num("--reasoning-max-tokens"),
    focus: args.includes("--no-focus") ? false : undefined,
  };
}

export async function startGoal(o: GoalOptions): Promise<string[]> {
  const res = await inngest.send(
    goalStarted.create(
      {
        goalId: o.goalId,
        model: o.model,
        maxAttempts: o.maxAttempts,
        maxStalls: o.maxStalls,
        maxTokensPerTurn: o.maxTokensPerTurn,
        reasoningEffort: o.reasoningEffort,
        reasoningMaxTokens: o.reasoningMaxTokens,
        focus: o.focus,
      },
      // Inngest Sessions: groups the goal-loop run under AI > Sessions in the
      // dashboard. Sessions propagate through step.invoke / step.sendEvent by
      // default, so every agent-attempt run of this goal lands in the same one.
      { meta: { sessions: { goal_id: o.goalId } } },
    ),
  );
  return res.ids;
}
