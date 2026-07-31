import { inngest } from "../../../inngest/client";
import { chatChannel } from "../../../inngest/channel";

// Cancels the in-flight chat run for a session. The chat function declares
// `cancelOn: [{ event: "chat/cancel.requested", if: "async.data.sessionId ==
// event.data.sessionId" }]` (see worker/chat-function.ts), so this event tears
// the matching run down at its next step boundary — durably, from outside the
// worker. We also publish `run.cancelled` immediately so any subscriber (this
// tab, or another one on the same session) settles to a neutral "stopped"
// state without waiting for the catch-up poll to observe the Cancelled run.
export async function POST(req: Request) {
  const { sessionId } = (await req.json()) as { sessionId?: string };

  if (!sessionId) {
    return Response.json({ error: "Expected { sessionId }" }, { status: 400 });
  }

  await inngest.send({ name: "chat/cancel.requested", data: { sessionId } });
  // Best-effort live notice — the durable teardown is driven by the event above,
  // so a dropped publish just means the client relies on its own optimistic
  // settle (and the catch-up poll) instead.
  await inngest.realtime
    .publish(chatChannel(sessionId).status, { type: "run.cancelled" })
    .catch(() => {});

  return Response.json({ ok: true });
}
