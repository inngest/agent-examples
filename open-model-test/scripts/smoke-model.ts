// M2 smoke test: bypasses Inngest entirely and exercises the adapter layer —
// one real generation per model against the first task in the suite. Verifies
// auth, streaming metrics, and code extraction before any matrix run.
//
// In v3 this is the Δ1 gate (spec v3 §14): it verifies the Nebius endpoint,
// the exact M3 model string, streaming + usage shape, and the thinking
// toggle's wire spelling against the live API.
//
//   bun run smoke:model [taskId]

import { config } from "../src/config";
import { loadTasks } from "../src/tasks";
import { buildGenerationRequest, createAdapter, providerTarget } from "../src/models/adapter";

for (const model of config.models) {
  const { apiKeyEnv, baseURL } = providerTarget(model);
  if (!process.env[apiKeyEnv]) {
    console.error(`${apiKeyEnv} is required for ${model.id} via ${baseURL} (see .env.example)`);
    process.exit(1);
  }
}

const tasks = loadTasks();
const task = tasks.find((t) => t.id === process.argv[2]) ?? tasks[0]!;
console.log(`task: ${task.id} (${task.language}, ${task.tier})\n`);

for (const model of config.models) {
  const { baseURL } = providerTarget(model);
  const thinking = model.params.thinking;
  console.log(
    `── ${model.id}  [${model.model}] via ${baseURL}${thinking !== undefined ? `  thinking=${thinking}` : ""}`,
  );
  const req = buildGenerationRequest(task, model, config, 1234, { turn: 1, prevFiles: null, prevFeedback: null });
  const result = await createAdapter(model).generate(req);
  console.log(`   extracted:       ${result.extracted}`);
  console.log(`   tokens:          ${result.tokensPrompt ?? "?"} in / ${result.tokensCompletion ?? "?"} out`);
  console.log(`   ttft:            ${result.ttftMs ?? "?"} ms`);
  console.log(`   tokens/sec:      ${result.tokensPerSec?.toFixed(1) ?? "?"}`);
  console.log(`   latency:         ${result.latencyMs} ms`);
  console.log(`   cost:            $${result.costUsd?.toFixed(6) ?? "?"}`);
  console.log(`   code (${result.code.split("\n").length} lines):`);
  for (const line of result.code.split("\n").slice(0, 12)) {
    console.log(`   | ${line}`);
  }
  const total = result.code.split("\n").length;
  if (total > 12) console.log(`   | ... (${total - 12} more lines)`);
  console.log();
}
