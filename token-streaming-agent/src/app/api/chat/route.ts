import { inngest } from "../../../inngest/client";
import type { ChatMessage } from "../../../inngest/channel";

// Stateless server: the browser owns the full transcript and sends it on
// every request (see components/Chat.tsx). Simplest possible design for an
// example — a real app would likely persist history server-side instead.
export async function POST(req: Request) {
  const { sessionId, messages } = (await req.json()) as { sessionId: string; messages: ChatMessage[] };

  if (!sessionId || !Array.isArray(messages)) {
    return Response.json({ error: "Expected { sessionId, messages }" }, { status: 400 });
  }

  const { ids } = await inngest.send({
    name: "chat/message.sent",
    data: { sessionId, messages },
    // Session context (Inngest "Sessions"): groups every run of one
    // conversation under AI > Sessions in the dashboard — run counts,
    // failure rates, and per-conversation drill-down for eval debugging.
    // Purely metadata; doesn't change which functions execute.
    meta: {
      sessions: {
        conversation_id: sessionId,
      },
    },
  });

  return Response.json({ eventId: ids[0] });
}
