import type Anthropic from "@anthropic-ai/sdk";

// The mock payment gateway is flaky: each charge attempt fails with this
// probability. There's no retry here, so a failure takes the whole run down —
// that's the fragility this stage exists to show. Set CHARGE_FAILURE_RATE=1 to
// force the break (e.g. for a recording) or 0 to always succeed.
const FAILURE_RATE = Number(process.env.CHARGE_FAILURE_RATE ?? 0.5);

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
const toolHandlers: Record<string, (input: any) => Promise<string>> = {
  async charge_credit_card(input) {
    if (Math.random() < FAILURE_RATE) {
      throw new Error(
        `payment gateway timed out while charging $${input.amount} — connection reset by peer`,
      );
    }
    return JSON.stringify({ amount: input.amount, status: "charged", confirmation: `ch_${crypto.randomUUID()}` });
  },
};

export async function executeTool(name: string, input: any): Promise<string> {
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(input);
}
