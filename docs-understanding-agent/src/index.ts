import express from "express";
import { serve } from "inngest/express";
import { config } from "./config";
import { githubWebhooks } from "./github/webhooks";
import { inngest } from "./inngest/client";
import { functions } from "./inngest/functions";

// Safety net: an unhandled rejection or uncaught exception anywhere in the
// process shouldn't take the whole server down (Express 4 route handlers and
// stray promises can't always be caught at the source).
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

const app = express();

// Webhook route needs the raw body for signature verification, so it mounts
// before the global JSON parser.
app.use("/api/github/webhooks", express.raw({ type: "application/json" }), githubWebhooks);

app.use(express.json());
app.use("/api/inngest", serve({ client: inngest, functions }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`docs-understanding-agent listening on http://localhost:${config.port}`);
  if (config.dryRunGithub) console.log("DRY_RUN_GITHUB=1 — GitHub API calls are stubbed");
});
