import { config } from "../config";
import { chatCompletion, parseJsonBlock, type PageSummary } from "./openrouter";

const REFUSAL_PATTERNS = /\b(i cannot|i can't|unable to|insufficient content|no content provided)\b/i;

// Cheap deterministic checks on the summary shape — did the model actually
// engage with the page rather than refuse or return filler?
export function heuristicScore(summary: PageSummary): number {
  let score = 0;
  if (summary.pageTopic.length >= 20 && !REFUSAL_PATTERNS.test(summary.pageTopic)) score += 0.4;
  if (summary.keyConcepts.length >= 2) score += 0.3;
  if (summary.intendedAudience.length > 0) score += 0.15;
  if (summary.confidence >= 0.5) score += 0.15;
  return Math.round(score * 100) / 100;
}

const JUDGE_SYSTEM = `You are grading how well an LLM understood a documentation page.
You get the page text and the model's structured summary of it. Grade the summary on:
- accuracy: does it describe what the page actually says?
- coverage: does it capture the page's key concepts?
- audience-fit: did it correctly identify who the page is for?
Respond with ONLY a JSON object: {"clarity": <0-1 number>, "reasoning": "<one sentence>"}.
A high clarity score means the page was easy for the LLM to understand correctly.`;

export type JudgeResult = { clarity: number; reasoning: string };

export async function judgeSummary(pageText: string, summary: PageSummary): Promise<JudgeResult> {
  const raw = await chatCompletion({
    model: config.judgeModel,
    system: JUDGE_SYSTEM,
    user:
      `Page content:\n\n${pageText.slice(0, 8_000)}\n\n` +
      `Model summary:\n\n${JSON.stringify(summary, null, 2)}`,
  });
  const parsed = parseJsonBlock<Partial<JudgeResult>>(raw);
  return {
    clarity: Math.max(0, Math.min(1, Number(parsed.clarity ?? 0))),
    reasoning: String(parsed.reasoning ?? ""),
  };
}
