import type Anthropic from "@anthropic-ai/sdk";

// Flipped live via POST /api/kill-switch to simulate charge_credit_card
// failing, then auto-reverting after a random 1-2 tries so retries recover.
let killSwitchEnabled = false;
let failuresBeforeAutoRevert = 2;

export function setKillSwitch(enabled: boolean): void {
  killSwitchEnabled = enabled;
  failuresBeforeAutoRevert = enabled ? 1 + Math.floor(Math.random() * 2) : 0;
}

export function isKillSwitchEnabled(): boolean {
  return killSwitchEnabled;
}

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
    if (killSwitchEnabled) {
      failuresBeforeAutoRevert -= 1;
      if (failuresBeforeAutoRevert <= 0) {
        killSwitchEnabled = false;
      }
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
