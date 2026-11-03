import fs from "node:fs";
import express from "express";
import { serve } from "inngest/express";
import { agents, inngest } from "./inngest/client.js";
// Registers the goal and coder agents with `agents`.
import "./agents/goal.js";

if (fs.existsSync(".env")) process.loadEnvFile?.();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/inngest", serve({ client: inngest, functions: agents.functions() }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`goal-loop listening on :${port} (/api/inngest)`));
