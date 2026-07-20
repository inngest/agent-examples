import { connect, ConnectionState } from "inngest/connect";
import { inngest } from "./inngest/client";
import { runAgentFn } from "./inngest/functions";
import { toolFunctions } from "./inngest/tool-functions";
import { isKillSwitchEnabled, setKillSwitch } from "./tools";

const functions = [runAgentFn, ...Object.values(toolFunctions)];

// Establish an outbound persistent connection to Inngest. This replaces the
// inbound /api/inngest serve endpoint: Inngest Cloud pushes step invocations
// to this worker over WebSocket, so no public ingress is required.
const connection = await connect({
  apps: [{ client: inngest, functions }],
  // Identifies this worker instance for horizontal scaling and rolling deploys.
  // Defaults to hostname if unset; in containers set this to the container id.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

console.log("Worker: connected", connection.state);

// Tiny HTTP server for the trigger endpoints + a readiness probe. This is the
// only inbound surface — the functions themselves run via the connect socket.
Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/agent": {
      async POST(req) {
        const { prompt } = await req.json();
        const { ids } = await inngest.send({
          name: "agent/run.requested",
          data: { prompt },
        });
        return Response.json({ eventId: ids[0] });
      },
    },
    "/api/kill-switch": {
      async POST(req) {
        const { enabled } = await req.json();
        setKillSwitch(Boolean(enabled));
        return Response.json({ killSwitchEnabled: isKillSwitchEnabled() });
      },
      GET() {
        return Response.json({ killSwitchEnabled: isKillSwitchEnabled() });
      },
    },
    // Health/readiness probe for containerized environments. Returns 200 only
    // when the connect socket is ACTIVE so load balancers route traffic here
    // only when the worker can actually execute steps.
    "/ready": {
      GET() {
        if (connection.state === ConnectionState.ACTIVE) {
          return new Response("OK", { status: 200 });
        }
        return new Response("NOT OK", { status: 500 });
      },
    },
  },
});

console.log(`HTTP server running at http://localhost:${process.env.PORT ?? 3000}`);

// Block until the connect socket gracefully closes (SIGTERM/SIGINT), then exit.
await connection.closed;
console.log("Worker: shut down");
process.exit(0);
