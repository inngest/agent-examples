import fs from "node:fs";
import { image } from "inngest/experimental";
import { sandbox } from "inngest/experimental/agents";
import { casesPath } from "../check/score-core.js";
import { WORKSPACE_PACKAGE_JSON, WORKSPACE_TSCONFIG } from "./lib/workspace-files.js";
import { finish } from "./tools/finish.js";
import { typechecked } from "./tools/typechecked.js";

const { run, read, edit, write } = sandbox.tools;

// The model's machine: node, tsc and git (images/coder), on the goal's thread.
// Each attempt writes the code it starts from (src/agents/coder.ts). The
// model's shell starts in src/, where every path it's given is relative to.
export const work = sandbox({
  id: "work",
  image: image.custom("semver-coder:v1"),
  cwd: "/work/src",
  tools: { run, read, edit: typechecked(edit), write: typechecked(write), finish },
  setup: async ({ sandbox, restored }) => {
    if (restored) return;
    await sandbox.files.write("package.json", { path: "/work/package.json", data: WORKSPACE_PACKAGE_JSON });
    await sandbox.files.write("tsconfig.json", { path: "/work/tsconfig.json", data: WORKSPACE_TSCONFIG });
    await sandbox.$({ cwd: "/work" }).sh`git init -q && git config user.name goal-loop && git config user.email goal-loop@localhost`;
  },
});

// The grader's machine, one per goal, holding the train cases (check/grade.ts
// runs candidates on it and brings the holdout only to score it). The goal
// lists it code-only, so the model has no tools on it and the cases stay out
// of reach.
export const grader = sandbox({
  id: "grader",
  vcpu: 1,
  memoryMb: 1024,
  setup: async ({ sandbox, restored }) => {
    if (restored) return;
    await sandbox.files.write("package", { path: "/check/package.json", data: JSON.stringify({ type: "module" }) });
    await sandbox.files.write("cases-train", { path: "/check/cases.train.jsonl", data: fs.readFileSync(casesPath("train"), "utf8") });
  },
});
