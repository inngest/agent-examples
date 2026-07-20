import { runAgent } from "./agent";
import { isKillSwitchEnabled, setKillSwitch } from "./tools";

// Stage 2 keeps these routes but registers its Inngest functions here via
// connect() (an outbound WebSocket), so the agent run happens in the background.

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/agent": {
      async POST(req) {
        const { prompt } = await req.json();
        const content = await runAgent(prompt);
        return Response.json({ content });
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
  },
  // Overrides Bun's dev-mode HTML error overlay with a clean one-liner.
  error(error) {
    console.error(`agent run failed: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  },
});

console.log(`Agent server running at http://localhost:${process.env.PORT ?? 3000}`);
