// pnpm eval -- [--set brief-v1] [--repeats N] [--max-attempts N] [--variants a,b] [--sequential]
// Sends one goal/started per (variant x repeat) of an eval set (evals/<set>.json),
// each with a fixed brief variant so every variant gets the same number of runs.
// Goal ids are eval-<set>-<yyyymmdd-hhmmss>-<variant>-r<k>; the part before the
// variant is the batch id that `pnpm eval:report -- --batch <id>` takes.
// --sequential sends a run, waits for its goal/finished, then the next (the
// local backend shares one workspace/ repo, so runs can't overlap there).
import fs from "node:fs";
import path from "node:path";
import { VARIANT_NAMES, type BriefVariant } from "../src/inngest/events.js";
import { fetchEvents } from "../src/lib/goal-history.js";
import { startGoal } from "../src/lib/start-goal.js";

type EvalSet = { name: string; variants: string[]; repeats: number; maxAttempts: number; model?: string };

const args = process.argv.slice(2).filter((a) => a !== "--");
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const setName = get("--set") ?? "brief-v1";
const file = path.join(import.meta.dirname, "..", "evals", `${setName}.json`);
if (!fs.existsSync(file)) {
  console.error(`no eval set at ${file}`);
  process.exit(2);
}
const set = JSON.parse(fs.readFileSync(file, "utf8")) as EvalSet;
const repeats = Number(get("--repeats") ?? set.repeats);
const maxAttempts = Number(get("--max-attempts") ?? set.maxAttempts);
const requested = get("--variants")?.split(",") ?? set.variants;
const unknown = requested.filter((v) => !(VARIANT_NAMES as string[]).includes(v));
const variants = requested as BriefVariant[];
const timeoutMin = Number(get("--timeout-min") ?? maxAttempts * 10);
if (unknown.length) console.error(`unknown variants: ${unknown.join(", ")}`);
if (unknown.length || !variants.length || !(timeoutMin > 0) || !Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
  console.error(`usage: pnpm eval -- [--set <name>] [--repeats N] [--max-attempts N] [--variants ${VARIANT_NAMES.join(",")}] [--sequential] [--timeout-min N]`);
  process.exit(2);
}

const now = new Date().toISOString();
const batch = `eval-${set.name}-${now.slice(0, 10).replaceAll("-", "")}-${now.slice(11, 19).replaceAll(":", "")}`;
console.log(`batch ${batch}: ${variants.length} variants x ${repeats} repeats, up to ${maxAttempts} attempts each`);

const sequential = args.includes("--sequential");
for (let k = 1; k <= repeats; k++) {
  for (const variant of variants) {
    const goalId = `${batch}-${variant}-r${k}`;
    // 60s back, for clock skew between here and the events API.
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    // maxStalls > maxAttempts: an eval run never parks for a review.
    const ids = await startGoal({ goalId, model: set.model, maxAttempts, maxStalls: maxAttempts + 1, variant });
    console.log(`sent ${goalId} ids=${ids.join(",")}`);
    if (sequential) {
      // A run that fails or is cancelled never sends goal/finished: give up at the deadline.
      const deadline = Date.now() + timeoutMin * 60_000;
      let done = false;
      while (!done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15_000));
        try {
          done = (await fetchEvents("goal/finished", sentAt, 1)).some((e) => e.data?.goalId === goalId);
        } catch (err) {
          console.error(`poll failed, retrying: ${err instanceof Error ? err.message : err}`);
        }
      }
      console.log(done ? `finished ${goalId}` : `timed out after ${timeoutMin} min waiting for ${goalId}; moving on`);
    }
  }
}
console.log(`\nreport: pnpm eval:report -- --batch ${batch}`);
