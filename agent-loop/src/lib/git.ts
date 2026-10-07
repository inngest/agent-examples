import fs from "node:fs/promises";
import { simpleGit } from "simple-git";
import { WORKSPACE_DIR } from "./paths.js";

const git = () => simpleGit(WORKSPACE_DIR);

// reset --hard / clean -fd are destructive: refuse to run unless the workspace
// is its own git repo (not a subdirectory of some enclosing repo).
async function assertOwnRepo(): Promise<void> {
  const top = (await git().revparse(["--show-toplevel"])).trim();
  const [a, b] = await Promise.all([fs.realpath(top), fs.realpath(WORKSPACE_DIR)]);
  if (a !== b) {
    throw new Error(`workspace ${b} is not its own git repo (toplevel is ${a}); refusing`);
  }
}

export async function headSha(): Promise<string> {
  return (await git().revparse(["HEAD"])).trim();
}

export async function resetHard(sha: string): Promise<void> {
  await assertOwnRepo();
  await git().raw(["reset", "--hard", sha]);
  await git().raw(["clean", "-fd"]);
}

export async function isDirty(): Promise<boolean> {
  const status = await git().status();
  return !status.isClean();
}

export async function commitAll(message: string): Promise<string> {
  await assertOwnRepo();
  await git().raw(["add", "-A"]);
  await git().raw([
    "-c", "user.name=goal-loop",
    "-c", "user.email=goal-loop@localhost",
    "commit", "--no-verify", "-m", message,
  ]);
  return headSha();
}

export async function headMessage(): Promise<string> {
  return (await git().raw(["log", "-1", "--format=%s"])).trim();
}
