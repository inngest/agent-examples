// In-process reply delivery. The Hono HTTP handler and the Inngest Connect
// worker live in the same Bun process, so when a `record-message` run
// executes here it can resolve the HTTP request's pending promise directly —
// no round-trip through the Inngest REST API. (Inngest Cloud's REST API does
// not expose run output, so polling /v1/events/:id/runs for `output` cannot
// work against Cloud — hence this in-process bus.)
//
// Single-instance assumption: with several Connect workers behind one load
// balancer, a run may execute on a different instance than the one holding
// the HTTP request, and this map would never resolve. For that topology,
// deliver replies through shared infrastructure (e.g. Inngest Realtime or a
// pub/sub store) instead.

export type ReplyPayload = { reply: string; variant?: string };

const waiters = new Map<string, (payload: ReplyPayload) => void>();

/**
 * Register a waiter for `messageId` and get a promise that resolves with the
 * run's reply, or `undefined` after `timeoutMs`. Call BEFORE sending the
 * triggering event so a fast run can't deliver into a not-yet-registered
 * waiter.
 */
export function waitForReply(
  messageId: string,
  timeoutMs: number,
): Promise<ReplyPayload | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(messageId);
      resolve(undefined);
    }, timeoutMs);
    waiters.set(messageId, (payload) => {
      clearTimeout(timer);
      waiters.delete(messageId);
      resolve(payload);
    });
  });
}

/**
 * Resolve the waiter for `messageId`, if one is still registered. Safe to
 * call more than once (an Inngest function body re-executes on each
 * memoization pass): only the first delivery resolves; the rest are no-ops.
 */
export function deliverReply(messageId: string, payload: ReplyPayload): void {
  waiters.get(messageId)?.(payload);
}
