import { z } from "zod";

// Single source of truth for the triage task: the allowed enum values, the
// strict output schema, the parser every caller uses to check a reply, and
// the system prompt that tells the model how to produce that output. Every
// other file that needs to know what "valid triage JSON" means imports from
// here rather than re-deriving it.
export const CATEGORIES = ["billing", "bug", "how-to", "feature-request", "account", "other"] as const;
export const URGENCIES = ["low", "medium", "high", "critical"] as const;
export const SENTIMENTS = ["positive", "neutral", "frustrated", "angry"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Urgency = (typeof URGENCIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

// .strict() rejects extra keys outright — a model that pads its JSON with an
// extra field (e.g. "confidence") should score as invalid, same as one that
// omits a required field or uses an out-of-enum value.
export const TriageSchema = z
  .object({
    category: z.enum(CATEGORIES),
    urgency: z.enum(URGENCIES),
    sentiment: z.enum(SENTIMENTS),
    suggested_reply: z.string().min(1),
  })
  .strict();

export type Triage = z.infer<typeof TriageSchema>;

// Strict on purpose: no markdown-fence stripping, no leniency. A model that
// wraps its JSON in ```json ... ``` or adds any surrounding prose fails
// JSON.parse and scores null here — that's exactly the "before" state the
// fine-tune is supposed to fix (valid-JSON rate ~50-70% -> ~100%), so this
// parser must not paper over the same sloppiness it's meant to measure.
export function parseTriage(reply: string): Triage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  const result = TriageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export const TRIAGE_SYSTEM_PROMPT = `You are a support-ticket triage assistant. Every user message is a customer support ticket (or a follow-up adding detail to one already in progress).

Respond with ONLY a single JSON object — no prose, no markdown, no code fences, nothing before or after the JSON. The object must have exactly these four keys:

{"category": <one of: "billing", "bug", "how-to", "feature-request", "account", "other">, "urgency": <one of: "low", "medium", "high", "critical">, "sentiment": <one of: "positive", "neutral", "frustrated", "angry">, "suggested_reply": <a short, empathetic, customer-facing reply the support team could send as-is>}

On follow-up turns, re-triage the ENTIRE ticket using all context so far — not just the latest message. Urgency and category may change as new information arrives: a ticket can escalate (e.g. "just me" becomes "my whole team, we have a demo in an hour"), or a question that first looked like "how-to" can turn out to be a "bug" once the customer describes something actually broken. Always output your best current read of the whole conversation, not an incremental patch.`;
