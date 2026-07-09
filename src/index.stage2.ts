import { serve } from "inngest/bun";
import { inngest } from "./inngest/client";
import { runAgentFn } from "./inngest/functions";
import { toolFunctions } from "./inngest/tool-functions";
import { isKillSwitchEnabled, setKillSwitch } from "./tools";

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/agent": {
      async POST(req) {
        const { prompt } = await req.json();
        const { ids } = await inngest.send({ name: "agent/run.requested", data: { prompt } });
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
    "/api/inngest": serve({ client: inngest, functions: [runAgentFn, ...toolFunctions] }),
  },
});

console.log(`Agent server running at http://localhost:${process.env.PORT ?? 3000}`);
