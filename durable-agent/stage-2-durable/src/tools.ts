import type Anthropic from "@anthropic-ai/sdk";

// The mock payment gateway is transiently flaky: each charge fails its first
// attempt or two, then goes through. Keyed by idempotency key so a charge's
// retries share one countdown — the durable agent's per-tool retries recover it
// automatically, with no switch to flip. (In-memory: assumes a single worker,
// resets on restart.)
const chargeFailuresRemaining = new Map<string, number>();

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "charge_credit_card",
    description: "Charge a customer's credit card for a given amount in USD.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to charge in USD" },
      },
      required: ["amount"],
    },
  },
];

// Registry of tool implementations, keyed by name — dispatch is a lookup,
// not a hardcoded switch, so agent.ts and tool-functions.ts share it as-is.
const toolHandlers: Record<string, (input: any, idempotencyKey?: string) => Promise<string>> = {
  async charge_credit_card(input, idempotencyKey) {
    // Simulate a transient gateway failure for the first attempt or two of this
    // charge. The retries share the same idempotency key, so the countdown is
    // per-charge — every run heals without any manual intervention.
    if (idempotencyKey) {
      if (!chargeFailuresRemaining.has(idempotencyKey)) {
        chargeFailuresRemaining.set(idempotencyKey, 1 + Math.floor(Math.random() * 2)); // 1–2
      }
      const remaining = chargeFailuresRemaining.get(idempotencyKey)!;
      if (remaining > 0) {
        chargeFailuresRemaining.set(idempotencyKey, remaining - 1);
        throw new Error(
          `payment gateway timed out while charging $${input.amount} — connection reset by peer`,
        );
      }
    }
    // Real provider: pass `idempotencyKey` as the request's idempotency key
    // (e.g. Stripe's `Idempotency-Key` header) so a retried charge — the tool
    // succeeded but the process died before the step recorded completion — is
    // deduplicated server-side. Here it's a mock, so we just carry the key.
    return JSON.stringify({
      amount: input.amount,
      status: "charged",
      confirmation: `ch_${crypto.randomUUID()}`,
      idempotencyKey,
    });
  },
};

export async function executeTool(name: string, input: any, idempotencyKey?: string): Promise<string> {
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(input, idempotencyKey);
}
