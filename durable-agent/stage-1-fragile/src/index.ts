import { runAgent } from "./agent";

// Stage 2 keeps this route but registers its Inngest functions here via
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
  },
  // Overrides Bun's dev-mode HTML error overlay with a clean one-liner.
  error(error) {
    console.error(`agent run failed: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  },
});

console.log(`Agent server running at http://localhost:${process.env.PORT ?? 3000}`);
