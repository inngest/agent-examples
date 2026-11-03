// One attempt, on the goal's thread: it seeds its sandbox with the best code,
// works until work_finish, and hands back what it did. What earlier attempts
// tried comes in the brief (the goal's journal, rebuilt from step results), so
// a clean history each time loses nothing. A reviewer's note sent while it
// works reaches the model's very next call.
import { formatEvent, hasToolCall } from "inngest/experimental/agents";
import { agents } from "../inngest/client.js";
import { attemptRequested, goalReviewSubmitted } from "../inngest/events.js";
import type { Files } from "../lib/files.js";
import { liveTurns } from "../lib/live.js";
import { SYSTEM_PROMPT } from "../lib/prompt.js";
import { openrouter, settledRung } from "../models/openrouter.js";
import { work } from "../sandboxes.js";

export const coder = agents.agent(
  {
    id: "coder",
    triggers: [attemptRequested],
    thread: "event.data.goalId",
    inbox: [goalReviewSubmitted],
    model: ({ event }) => openrouter(event.data.model),
    system: SYSTEM_PROMPT,
    sandboxes: { work },
    remember: false,
    discovery: false,
    retries: 2,
    loop: {
      // Small models otherwise write code as chat. The only way out is work_finish.
      toolChoice: "required",
      stop: hasToolCall("work_finish"),
      format: (message) => {
        if (!message.is(goalReviewSubmitted)) return formatEvent(message);
        if (message.data.action === "stop") return "Your reviewer is stopping the goal. Call work_finish now with a one-line summary.";
        return `A note from your reviewer: ${message.data.note ?? ""}`;
      },
    },
  },
  async ({ event, loop, sandboxes }) => {
    const { goalId, i, brief, files, maxTurns } = event.data;
    const git = sandboxes.work.$({ cwd: "/work" });

    // Start from the best code, committed, so `git status` shows what this attempt changes.
    await git.sh`rm -rf src && mkdir src`;
    for (const [path, data] of Object.entries(files)) {
      await sandboxes.work.files.write(`start ${path}`, { path: `/work/src/${path}`, data });
    }
    await git.sh`git add -A && git commit -qm ${`start ${i}`} --allow-empty`;

    const result = await loop(brief, { maxTurns, onTurn: liveTurns(goalId, i) });

    const changed = (await git`git status --porcelain`.text()) !== "";
    const commit = await git.sh`git add -A && git commit -qm ${`attempt ${i}`} --allow-empty && git rev-parse HEAD`.text();
    const finish = result.toolCalls.findLast((run) => run.name === "work_finish" && !run.isError);

    return {
      commit,
      files: await sandboxes.work.$`snapshot`.json<Files>(),
      changed,
      summary: finish?.output.summary ?? `(no work_finish after ${result.turns} turns, ended by ${result.end})`,
      finished: Boolean(finish),
      turns: result.turns,
      noToolCallTurns: result.noToolCallTurns,
      usage: result.usage,
      rung: settledRung(result.history),
    };
  },
);
