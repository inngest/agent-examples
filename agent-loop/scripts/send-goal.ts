// pnpm goal:send -- --goal <id> [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N]
// Sends goal/started. Targets the dev server or Inngest Cloud depending on env
// (INNGEST_DEV=1 vs INNGEST_EVENT_KEY).
import { parseGoalArgs, startGoal } from "../src/lib/start-goal.js";

const opts = parseGoalArgs(process.argv.slice(2));
if (!opts.goalId) {
  console.error("usage: pnpm goal:send -- --goal <id> [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N]");
  process.exit(2);
}
const ids = await startGoal({ ...opts, goalId: opts.goalId });
console.log(`sent goal/started goalId=${opts.goalId} model=${opts.model ?? "(worker MODEL env)"} ids=${ids.join(",")}`);
