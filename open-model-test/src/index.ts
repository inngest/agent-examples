import { connect, ConnectionState } from "inngest/connect";
import { Hono } from "hono";
import { inngest } from "./inngest/client";
import { allFunctions } from "./inngest/functions";
import { EVENTS } from "./inngest/events";
import { completionCount, getRun, listRuns } from "./db";

// Functions registered over the connect socket — NOT via a /api/inngest serve
// endpoint. The Dev Server (or Inngest Cloud) pushes step invocations to this
// worker over a persistent WebSocket. Auto-syncs on connect; no manual sync.

const app = new Hono();

// Kick off a full matrix run. The runId is generated here (not inside the
// function) so the response can return it immediately. meta.sessions tags the
// root event with the benchmark run — session propagation (on by default)
// stamps every child run (orchestrate, samples, tally, aggregate) with the
// same session, so the whole benchmark is one timeline in the dashboard.
app.post("/api/run", async (c) => {
  const runId = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
  await inngest.send({
    name: EVENTS.runRequested,
    data: { runId },
    meta: { sessions: { benchmark_run: runId } },
  });
  return c.json({ runId, url: `/runs/${runId}` }, 202);
});

app.get("/runs", (c) => {
  const runs = listRuns().map((run) => ({
    ...run,
    completed_samples: completionCount(run.run_id),
  }));
  return c.json({ runs });
});

app.get("/runs/:runId", (c) => {
  const run = getRun(c.req.param("runId"));
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json({ run, completed_samples: completionCount(run.run_id) });
});

const port = Number(process.env.PORT ?? 3001);

// Outbound persistent connection to Inngest. There is no /api/inngest route —
// the worker reaches out to Inngest, and step invocations are pushed down the
// socket. Long-running steps aren't bound by HTTP timeouts.
const connection = await connect({
  apps: [{ client: inngest, functions: allFunctions }],
  // Identifies this worker instance for horizontal scaling and rolling deploys.
  // Defaults to hostname; in containers set this to the container id.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

// Readiness probe — returns 200 only when the connect socket is ACTIVE, so a
// load balancer routes traffic here only when the worker can run steps.
app.get("/ready", (c) =>
  connection.state === ConnectionState.ACTIVE ? c.text("OK", 200) : c.text("NOT OK", 500),
);

Bun.serve({ port, fetch: app.fetch });

console.log(`Worker: connected (${connection.state})`);
console.log(`Trigger: curl -X POST localhost:${port}/api/run`);

// Block until the connect socket gracefully closes (SIGTERM/SIGINT), then exit.
await connection.closed;
console.log("Worker: shut down");
process.exit(0);
