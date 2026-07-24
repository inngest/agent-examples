import { getClientSubscriptionToken } from "inngest/react";
import { inngest } from "../../../inngest/client";
import { chatChannel } from "../../../inngest/channel";

// Mints a short-lived subscription token scoped to one session's channel and
// its two topics. The browser fetches this right before subscribing with
// `useRealtime` (see components/Chat.tsx) — the token is never embedded in
// page HTML or reused across sessions. There is intentionally no auth here
// for the example: this route mints a token for whatever sessionId is
// posted, no questions asked. A production app must verify the caller
// actually owns that sessionId before minting a token for it.
export async function POST(req: Request) {
  const { sessionId } = (await req.json()) as { sessionId: string };

  if (!sessionId) {
    return Response.json({ error: "Expected { sessionId }" }, { status: 400 });
  }

  const token = await getClientSubscriptionToken(inngest, {
    channel: chatChannel(sessionId),
    topics: ["tokens", "status"],
  });

  return Response.json(token);
}
