// pnpm goal:send -- --goal <id> [flags]: sends goal/started and exits.
// Flags and targeting (dev server vs Inngest Cloud) are in src/lib/start-goal.ts.
import { parseGoalArgs, startGoal } from "../src/lib/start-goal.js";

const opts = parseGoalArgs(process.argv.slice(2));
if (!opts.goalId) {
  console.error("usage: pnpm goal:send -- --goal <id> [--model <slug>] [--max-attempts N] [--max-stalls N] [--max-tokens N] [--reasoning-effort low|medium|high] [--reasoning-max-tokens N] [--no-focus]");
  process.exit(2);
}
const ids = await startGoal({ ...opts, goalId: opts.goalId });
console.log(`sent goal/started goalId=${opts.goalId} model=${opts.model ?? "(worker MODEL env)"} ids=${ids.join(",")}`);
