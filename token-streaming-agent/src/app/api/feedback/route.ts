import { inngest } from "../../../inngest/client";

// Receives a 👍/👎 on one assistant response and publishes it as a
// `chat/feedback.received` event. The deferred `feedback-scorer` (enqueued
// when the chat run finished — see worker/chat-function.ts) is parked on a
// `waitForEvent` keyed by `eventId`, so this send is what wakes it and turns
// the click into a `user-feedback` score on that run's experiment variant.
export async function POST(req: Request) {
  const { eventId, helpful } = (await req.json()) as { eventId?: string; helpful?: boolean };

  if (!eventId || typeof helpful !== "boolean") {
    return Response.json({ error: "Expected { eventId, helpful: boolean }" }, { status: 400 });
  }

  await inngest.send({
    name: "chat/feedback.received",
    // `eventId` is the chat run's triggering event id (returned by /api/chat);
    // the scorer's `waitForEvent` matches on `async.data.eventId` to correlate
    // this rating with the exact response it's for.
    data: { eventId, helpful },
  });

  return Response.json({ ok: true });
}
