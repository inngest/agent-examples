import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The task suite is versioned data, not code: one directory per task holding
// task.yaml (the contract shown to models, minus hidden tests) plus a hidden/
// directory that never leaves the sandbox, and — for agentic_fileops tasks —
// a workspace/ directory seeded into the sandbox as the starting codebase
// (model-visible, unlike hidden/). Suite version = content hash of this
// tasks/ tree at run time (src/version.ts).

export const TASKS_DIR =
  process.env.TASKS_DIR ?? new URL("../tasks", import.meta.url).pathname;

export const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    language: z.enum(["go", "typescript"]),
    tier: z.enum(["T1", "T2", "T3"]),
    // Workload axis — the headline cut of every report.
    task_type: z.enum(["coding", "agentic_fileops"]).default("coding"),
    prompt: z.string().min(1),
    // Required for coding tasks (the single file to write); empty for
    // agentic_fileops tasks, which write arbitrary files via markers.
    entrypoint: z.string().default(""),
    // Subdirectory of the task dir holding the seed repo for agentic tasks.
    workspace: z.string().default(""),
    test_command: z.string().min(1),
    build_command: z.string().min(1),
    static_checks: z.array(z.string()).default([]),
    hidden_tests: z.string().default("hidden/"),
    timeout_seconds: z.number().int().positive().default(60),
    // 1 = single-shot; >1 = agentic fix-loop (turns_to_green is recorded).
    max_agent_turns: z.number().int().min(1).default(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.task_type === "coding" && !t.entrypoint) {
      ctx.addIssue({ code: "custom", message: "coding tasks require entrypoint" });
    }
    if (t.task_type === "agentic_fileops" && !t.workspace) {
      ctx.addIssue({ code: "custom", message: "agentic_fileops tasks require workspace" });
    }
  });

export type Task = z.infer<typeof TaskSchema> & { dir: string };

export function loadTask(taskId: string): Task {
  const dir = join(TASKS_DIR, taskId);
  if (!existsSync(join(dir, "task.yaml"))) {
    throw new Error(`unknown task id: ${taskId} (no ${dir}/task.yaml)`);
  }
  const parsed = TaskSchema.parse(parseYaml(readFileSync(join(dir, "task.yaml"), "utf8")));
  if (parsed.id !== taskId) {
    throw new Error(`task id mismatch: directory ${taskId} contains task id ${parsed.id}`);
  }
  if (parsed.workspace && !existsSync(join(dir, ...parsed.workspace.split("/")))) {
    throw new Error(`task ${taskId}: workspace directory ${parsed.workspace} does not exist`);
  }
  if (!existsSync(join(dir, ...parsed.hidden_tests.split("/")))) {
    throw new Error(`task ${taskId}: hidden tests directory ${parsed.hidden_tests} does not exist`);
  }
  return { ...parsed, dir };
}

export function loadTasks(): Task[] {
  const tasks: Task[] = [];
  for (const entry of readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(TASKS_DIR, entry.name, "task.yaml"))) continue;
    tasks.push(loadTask(entry.name));
  }
  if (tasks.length === 0) throw new Error(`no tasks found in ${TASKS_DIR}`);
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}

// Files under the task's hidden/ directory: mounted into the sandbox alongside
// the generated code, never included in any prompt.
export function hiddenDir(task: Task): string {
  return join(task.dir, ...task.hidden_tests.split("/"));
}

// Files under the task's workspace/ directory: the seed codebase for
// agentic_fileops tasks — seeded into the sandbox AND shown to the model.
export function workspaceDir(task: Task): string | null {
  if (!task.workspace) return null;
  return join(task.dir, ...task.workspace.split("/"));
}

// Load a directory tree as a path → content map (used for both hidden/ and
// workspace/ — the difference is only who gets to see it, enforced by the
// prompt builder, not by this loader).
export function loadDirFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}
