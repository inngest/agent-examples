import { serve } from "inngest/hono";
import { Hono } from "hono";
import { inngest } from "./inngest/client";
import { agentRun } from "./inngest/functions";

const app = new Hono();

// Inngest discovers and invokes your functions through this endpoint.
app.use("/api/inngest", serve({ client: inngest, functions: [agentRun] }));

// Trigger endpoint: send an event, Inngest runs agent-run in the background.
app.post("/api/agent", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    prompt?: string;
    model?: string;
  };

  if (!body.prompt) {
    return c.json({ error: "missing 'prompt' in request body" }, 400);
  }

  const { ids } = await inngest.send({
    name: "agent/run.requested",
    data: { prompt: body.prompt, model: body.model },
  });

  return c.json({ eventId: ids[0] });
});

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};

console.log(`Hono app listening on http://localhost:${port}`);
console.log(`Trigger with:  POST http://localhost:${port}/api/agent`);
