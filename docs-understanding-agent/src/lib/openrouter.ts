import { config } from "../config";

export type PageSummary = {
  pageTopic: string;
  keyConcepts: string[];
  intendedAudience: string;
  ambiguities: string[];
  confidence: number;
};

type ChatOptions = {
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
};

export async function chatCompletion({ model, system, user, maxTokens = 1024 }: ChatOptions): Promise<string> {
  if (!config.openrouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${model} returned ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter ${model} returned no content`);
  }
  return content;
}

// Not all OpenRouter-routed models support response_format, so we ask for JSON
// in the prompt and parse leniently (models love to wrap JSON in code fences).
export function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  // Most models return a clean JSON object once unfenced — try that directly
  // before falling back to the brace-slice heuristic below (which is looser
  // but can be fooled by braces inside string values).
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    // fall through to brace-slice
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in model output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

const SUMMARIZE_SYSTEM = `You evaluate how understandable a documentation or blog page is to LLM agents.
You are given the text content of one page. Summarize what the page is about as if you were an agent
trying to use it. Respond with ONLY a JSON object with these keys:
- "pageTopic": one or two sentences on what this page is about
- "keyConcepts": array of the 3-8 most important concepts/APIs/ideas the page teaches
- "intendedAudience": who this page is written for
- "ambiguities": array of things that were unclear, contradictory, or hard to follow (empty if none)
- "confidence": 0-1 number for how confident you are that you understood the page`;

export async function summarize(model: string, pageText: string): Promise<PageSummary> {
  const raw = await chatCompletion({
    model,
    system: SUMMARIZE_SYSTEM,
    user: `Page content:\n\n${pageText}`,
  });
  const parsed = parseJsonBlock<Partial<PageSummary>>(raw);
  return {
    pageTopic: String(parsed.pageTopic ?? ""),
    keyConcepts: Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts.map(String) : [],
    intendedAudience: String(parsed.intendedAudience ?? ""),
    ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities.map(String) : [],
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
  };
}
