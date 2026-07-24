import { connect } from "inngest/connect";
import { inngest } from "../inngest/client";
import { chatFn } from "./chat-function";

// Establish an outbound persistent connection to Inngest. There is no
// `/api/inngest` serve route anywhere in this app — the `chat-agent` function
// is registered only here, via Connect. Inngest pushes step invocations to
// this worker over WebSocket, so no public ingress is required for the
// function to run.
const connection = await connect({
  apps: [{ client: inngest, functions: [chatFn] }],
  // Identifies this worker instance for horizontal scaling and rolling
  // deploys. Defaults to hostname if unset; in containers set this to the
  // container id.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

console.log("Worker: connected", connection.state);

// Block until the connect socket gracefully closes (SIGTERM/SIGINT), then exit.
await connection.closed;
console.log("Worker: shut down");
process.exit(0);
