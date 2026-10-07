// Recreate the agent's workspace (local backend) from workspace-template as a
// fresh git repo. Used by `pnpm workspace:reset` and by `goal:watch` before it
// starts a goal.
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { REPO_ROOT, WORKSPACE_DIR } from "./paths.js";
import { WORKSPACE_PACKAGE_JSON, WORKSPACE_TSCONFIG } from "./workspace-files.js";

export async function resetWorkspace(): Promise<string> {
  const template = path.join(REPO_ROOT, "workspace-template");
  fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  fs.cpSync(template, WORKSPACE_DIR, { recursive: true });

  fs.writeFileSync(path.join(WORKSPACE_DIR, "package.json"), WORKSPACE_PACKAGE_JSON);
  fs.writeFileSync(path.join(WORKSPACE_DIR, "tsconfig.json"), WORKSPACE_TSCONFIG);

  const git = (...args: string[]) => execa("git", args, { cwd: WORKSPACE_DIR, stdin: "ignore" });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "goal-loop");
  await git("config", "user.email", "goal-loop@example.invalid");
  await git("add", "-A");
  await git("commit", "-q", "-m", "stubs");
  const { stdout } = await git("rev-parse", "HEAD");
  return stdout.trim();
}
