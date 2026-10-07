// Connect entrypoint (Inngest Cloud / Render): the worker dials out to Inngest
// over a persistent WebSocket, so there is no /api/inngest route. src/server.ts
// (express serve) stays for local dev.
import http from "node:http";
import { connect, ConnectionState } from "inngest/connect";
import { inngest } from "./inngest/client.js";
import { goalLoop } from "./inngest/goal-loop.js";
import { agentAttempt } from "./inngest/agent-attempt.js";

const connection = await connect({
  apps: [{ client: inngest, functions: [goalLoop, agentAttempt] }],
  // Identifies this worker instance for rolling deploys; defaults to hostname.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

// Readiness probe: 200 only while the connect socket is ACTIVE.
const port = Number(process.env.PORT ?? 3000);
const probe = http.createServer((_req, res) => {
  const ready = connection.state === ConnectionState.ACTIVE;
  res.writeHead(ready ? 200 : 500, { "content-type": "text/plain" });
  res.end(ready ? "OK" : "NOT OK");
});
probe.listen(port);

console.log(`goal-loop worker: connected (${connection.state}), backend=${process.env.WORKSPACE_BACKEND ?? "local"}, probe on :${port}`);

// Block until the connect socket closes gracefully (SIGTERM/SIGINT), then exit.
await connection.closed;
probe.close();
console.log("goal-loop worker: shut down");
process.exit(0);
