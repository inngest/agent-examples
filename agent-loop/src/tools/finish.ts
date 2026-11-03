import { NonRetriableError } from "inngest";
import { tool } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { z } from "zod";

// Ends the attempt: the coder's loop stops when it succeeds. Refused while the
// tree is unchanged, since small models otherwise finish with a plan instead
// of a change. `git status` sees edits, new files and deleted ones.
export const finish = tool.group({
  description: "End this attempt. Call it once you have made your change and it typechecks.",
  input: z.object({ summary: z.string().describe("One sentence: what you changed, or why the check looks wrong.") }),
  run: async ({ summary }, { sandbox }) => {
    if (!sandbox) throw new NonRetriableError("finish works on a sandbox: list it in a sandbox's tools");

    const changed = await sandbox.$({ cwd: "/work" })`git status --porcelain`.text();
    if (changed === "") {
      return agent.toolError(
        "You haven't changed any file in this attempt, so there is nothing to finish. Make the change now with work_edit or work_write, then call work_finish.",
      );
    }

    return { summary };
  },
});
