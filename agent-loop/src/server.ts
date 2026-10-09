import fs from "node:fs";
import express from "express";
import { serve } from "inngest/express";
import { inngest } from "./inngest/client.js";
import { goalLoop } from "./inngest/goal-loop.js";
import { agentAttempt } from "./inngest/agent-attempt.js";

if (fs.existsSync(".env")) process.loadEnvFile?.();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/inngest", serve({ client: inngest, functions: [goalLoop, agentAttempt] }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`goal-loop listening on :${port} (/api/inngest)`));
