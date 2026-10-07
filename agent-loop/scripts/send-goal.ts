// pnpm goal:send -- --goal <id> [--model <slug>] [--max-attempts N] [--max-stalls N]
// Sends goal/started. Targets the dev server or Inngest Cloud depending on env
// (INNGEST_DEV=1 vs INNGEST_EVENT_KEY).
import { inngest } from "../src/inngest/client.js";
import { goalStarted } from "../src/inngest/events.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (flag: string) => {
  const v = get(flag);
  return v === undefined ? undefined : Number(v);
};

const goalId = get("--goal");
if (!goalId) {
  console.error("usage: pnpm goal:send -- --goal <id> [--model <slug>] [--max-attempts N] [--max-stalls N]");
  process.exit(2);
}
// Unset → the worker resolves MODEL from its own env (or DEFAULT_MODEL).
const model = get("--model") ?? (process.env.MODEL || undefined);

const res = await inngest.send(
  goalStarted.create({ goalId, model, maxAttempts: num("--max-attempts"), maxStalls: num("--max-stalls") }),
);
console.log(`sent goal/started goalId=${goalId} model=${model ?? "(worker MODEL env)"} ids=${res.ids.join(",")}`);
