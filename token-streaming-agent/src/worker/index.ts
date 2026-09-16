import { connect } from "inngest/connect";
import { inngest } from "../inngest/client";
import { chatFn } from "./chat-function";
import { feedbackScorer } from "./feedback-scorer";

// How often to sample the connection's debug state. On a flaky link this is
// the granularity at which state flips and heartbeat gaps become visible.
const DIAG_INTERVAL_MS = 10_000;
// If no heartbeat response (or any message) has come back from the gateway in
// this long, the link is likely stalling even while state still reads ACTIVE —
// worth a warning.
const HEARTBEAT_STALE_MS = 15_000;

console.log("Worker: connecting…");
const connectStartedAt = Date.now();

// Establish an outbound persistent connection to Inngest. There is no
// `/api/inngest` serve route anywhere in this app — the `chat-agent` function
// is registered only here, via Connect. Inngest pushes step invocations to
// this worker over WebSocket, so no public ingress is required for the
// function to run. `feedbackScorer` is registered here too so Connect knows to
// run the deferred scorer `chatFn` enqueues via `defer(...)`.
const connection = await connect({
  apps: [{ client: inngest, functions: [chatFn, feedbackScorer] }],
  // Identifies this worker instance for horizontal scaling and rolling
  // deploys. Defaults to hostname if unset; in containers set this to the
  // container id.
  instanceId: process.env.INNGEST_INSTANCE_ID,
});

console.log(
  `Worker: connected id=${connection.connectionId} state=${connection.state} ` +
    `in ${((Date.now() - connectStartedAt) / 1000).toFixed(1)}s`,
);

// The Connect SDK exposes no state-change event, so poll getDebugState() — but
// only log on *transitions*, never a per-tick sample (that just floods the log
// on an otherwise healthy worker). Two things are edge-triggered: connection
// state flips (ACTIVE ↔ RECONNECTING/PAUSED/…), and the link going quiet (no
// gateway heartbeat within the threshold) or recovering. Per-request activity
// is logged by the function itself via `ctx.logger` (chat-function.ts /
// agent.ts), so you can watch it work through a request there.
let lastState = connection.state;
let wasStalled = false;

const ageMs = (ts: number | undefined): number | undefined => (ts ? Date.now() - ts : undefined);
const ago = (ms: number | undefined): string => (ms === undefined ? "never" : `${(ms / 1000).toFixed(1)}s ago`);

const diag = setInterval(() => {
  const d = connection.getDebugState();

  if (d.state !== lastState) {
    console.log(
      `Worker: connection ${lastState} → ${d.state}` +
        (d.activeConnectionId ? ` (id=${d.activeConnectionId})` : ""),
    );
    lastState = d.state;
  }

  // Edge-triggered stall detection: warn once when the gateway heartbeat goes
  // quiet, and note once when it comes back — not every interval.
  const heartbeatAge = ageMs(d.lastHeartbeatReceivedAt);
  const stalled = heartbeatAge !== undefined && heartbeatAge > HEARTBEAT_STALE_MS;
  if (stalled && !wasStalled) {
    console.warn(
      `Worker: link stalled — no gateway heartbeat in ${ago(heartbeatAge)} ` +
        `(state=${d.state} inflight=${d.inFlightRequestCount})`,
    );
  } else if (!stalled && wasStalled) {
    console.log("Worker: link recovered — heartbeats flowing again");
  }
  wasStalled = stalled;
}, DIAG_INTERVAL_MS);

// Don't let the diagnostics timer hold the process open on its own once the
// connection closes.
diag.unref?.();

// Block until the connect socket gracefully closes (SIGTERM/SIGINT), then exit.
await connection.closed;
clearInterval(diag);
console.log("Worker: shut down");
process.exit(0);
