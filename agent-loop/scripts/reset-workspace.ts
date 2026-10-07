// pnpm workspace:reset — recreate the agent's workspace from workspace-template as a fresh git repo.
import { WORKSPACE_DIR } from "../src/lib/paths.js";
import { resetWorkspace } from "../src/lib/reset-workspace.js";

const head = await resetWorkspace();
console.log(`workspace reset at ${WORKSPACE_DIR} (stubs @ ${head.slice(0, 12)})`);
