import Anthropic from "@anthropic-ai/sdk";
import type { GetStepTools } from "inngest";
import { inngest } from "../inngest/client";

const client = new Anthropic();
// Strong fixed judge regardless of which variant answered.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-opus-4-8";

type Step = GetStepTools<typeof inngest>;
export type Score = { name: string; value: number };

// Finds the first balanced `{...}` object in a judge reply by brace-depth
// scanning, rather than a greedy regex — a regex match runs to the *last*
// `}` in the text, which breaks if trailing prose contains a stray brace.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Extracts and validates the score out of a judge reply. Judge output is
// free-form prose around the JSON in practice, so a strict `JSON.parse` on
// the whole string is too brittle to rely on.
function parseJudgeReply(text: string): number | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { score?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    return Math.min(1, Math.max(0, score));
  } catch {
    return null;
  }
}

// Runs the judge call inside a memoized step (so a retried run doesn't re-bill
// the judge model), but parses its reply outside of step.run: a parse failure
// is a model-output problem, not a transient one, so re-running the same step
// would just reproduce the same unparseable text. The raw text is what gets
// memoized; an unparseable reply drops this score (returns null) rather than
// failing the whole chat run.
async function judge(step: Step, name: string, rubric: string): Promise<Score | null> {
  const reply = await step.run(`judge-${name}`, async () => {
    const message = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: rubric }],
    });
    const block = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return block?.text ?? "";
  });

  const value = parseJudgeReply(reply);
  if (value === null) return null;
  return { name, value };
}

export async function scoreConciseness(
  step: Step,
  prompt: string,
  actualOutput: string,
): Promise<Score | null> {
  const rubric = `Grade whether the answer is concise and free of filler. 1 = maximally concise while still complete, 0 = rambling or padded.

Question: ${prompt}
Answer: ${actualOutput}

Reply with ONLY {"score": <0-1>, "reason": "<one sentence>"}.`;
  return judge(step, "conciseness", rubric);
}

export async function scoreHelpfulness(
  step: Step,
  prompt: string,
  actualOutput: string,
): Promise<Score | null> {
  const rubric = `Grade whether the answer is helpful. 1 = fully and directly answers the request, 0 = ignores or misunderstands it.

Question: ${prompt}
Answer: ${actualOutput}

Reply with ONLY {"score": <0-1>, "reason": "<one sentence>"}.`;
  return judge(step, "helpfulness", rubric);
}

// Deterministic, no LLM call: unique tool invocations over total invocations,
// so a model that loops on the same call (or repeats an identical call)
// scores lower than one that calls each tool once. 1 when no tools were
// called at all — there's nothing inefficient about not needing tools.
export function scoreToolEfficiency(toolCalls: { name: string; input: unknown }[]): Score {
  if (toolCalls.length === 0) return { name: "tool-efficiency", value: 1 };
  const unique = new Set(toolCalls.map((c) => `${c.name}:${JSON.stringify(c.input)}`));
  return { name: "tool-efficiency", value: unique.size / toolCalls.length };
}
