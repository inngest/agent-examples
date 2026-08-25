// Triggers a full matrix run against the local worker and polls until it
// completes. Terminal 3 of the three-terminal setup:
//
//   bun run benchmark

const BASE = `http://localhost:${process.env.PORT ?? 3001}`;
const POLL_MS = 2_000;
const TIMEOUT_MS = 30 * 60_000;

const res = await fetch(`${BASE}/api/run`, { method: "POST" });
if (!res.ok) {
  console.error(`trigger failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { runId } = (await res.json()) as { runId: string };
console.log(`run started: ${runId}`);

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const statusRes = await fetch(`${BASE}/runs/${runId}`);
  if (!statusRes.ok) continue; // run row lands after orchestrate-run's first step
  const { run, completed_samples } = (await statusRes.json()) as {
    run: { status: string; expected_samples: number };
    completed_samples: number;
  };
  process.stdout.write(`\r${run.status}: ${completed_samples}/${run.expected_samples} samples`);
  if (run.status === "completed") {
    console.log(`\n\nsummary: results/${runId}/summary.json`);
    process.exit(0);
  }
}

console.error("\ntimed out waiting for run completion");
process.exit(1);
