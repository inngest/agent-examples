import type { GetStepTools } from "inngest";
import { inngest } from "../inngest/client";
import { openrouter } from "./openrouter";
import { toolDefinitions } from "./tools";
import type { ToolCall } from "./agent";
import type { ChatMessage } from "../inngest/channel";

// Strong fixed judge regardless of which variant answered — routed through
// OpenRouter like everything else, so the whole app uses a single provider and
// API key.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "anthropic/claude-opus-4.8";

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
    const completion = await openrouter.chat.completions.create({
      model: JUDGE_MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: rubric }],
    });
    return completion.choices[0]?.message.content ?? "";
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
export function scoreToolEfficiency(toolCalls: ToolCall[]): Score {
  if (toolCalls.length === 0) return { name: "tool-efficiency", value: 1 };
  const unique = new Set(toolCalls.map((c) => `${c.name}:${JSON.stringify(c.input)}`));
  return { name: "tool-efficiency", value: unique.size / toolCalls.length };
}

// Does a tool call carry the arguments its schema requires? A known tool whose
// parsed input contains all `required` params passes; an unknown tool name, or
// missing required fields, fails. Reads the `required` list straight off the
// tool definitions so it stays in sync with tools.ts.
function hasRequiredArgs(name: string, input: unknown): boolean {
  const tool = toolDefinitions.find((t) => t.type === "function" && t.function.name === name);
  if (!tool || tool.type !== "function") return false; // hallucinated tool name
  const required = (tool.function.parameters as { required?: string[] } | undefined)?.required ?? [];
  if (required.length === 0) return true;
  if (typeof input !== "object" || input === null) return false;
  const keys = input as Record<string, unknown>;
  return required.every((k) => k in keys);
}

// Deterministic tool-emit quality: of the tool calls a model actually emitted,
// what fraction were well-formed — parseable JSON arguments (see agent.ts's
// `parsedOk`) AND all schema-required params present. This is the sharp signal
// for "which model emits tool calls better": a model that streams broken JSON
// or drops a required field scores lower than one that emits clean calls.
// Returns null (skips the score) when no tools were emitted — validity only
// means something once a call was attempted, so unrelated no-tool turns don't
// dilute the metric.
export function scoreToolCallValidity(toolCalls: ToolCall[]): Score | null {
  if (toolCalls.length === 0) return null;
  const valid = toolCalls.filter((c) => c.parsedOk && hasRequiredArgs(c.name, c.input)).length;
  return { name: "tool-call-validity", value: valid / toolCalls.length };
}

// LLM-judge tool-emit quality: did the model call the tools this request
// actually needs? Complements the deterministic validity score above — that
// one can only grade calls that were made, whereas this catches the model
// answering from memory when it should have called a tool, or calling the
// wrong one. The judge sees the available tools, the request, and the calls
// that were made.
export async function scoreToolUseCorrectness(
  step: Step,
  prompt: string,
  toolCalls: ToolCall[],
): Promise<Score | null> {
  const toolList = toolDefinitions
    .filter((t) => t.type === "function")
    .map((t) => `- ${t.function.name}: ${t.function.description ?? ""}`)
    .join("\n");
  const callsMade = toolCalls.length
    ? toolCalls.map((c) => `- ${c.name}(${JSON.stringify(c.input)})`).join("\n")
    : "(no tool calls)";

  const rubric = `You are grading whether an assistant used tools correctly for a user request.

Available tools:
${toolList}

User request: ${prompt}

Tool calls the assistant made:
${callsMade}

Grade tool-use correctness. 1 = called exactly the tools the request needs with sensible arguments (or correctly made no calls when none were needed); 0 = skipped a tool the request needed, called the wrong tool, or made unnecessary calls.

Reply with ONLY {"score": <0-1>, "reason": "<one sentence>"}.`;
  return judge(step, "tool-use-correctness", rubric);
}

// One run_python attempt: the Python the model wrote plus how it executed. Pairs
// the assistant's tool_call arguments (the `code`) with its matching `tool`
// result (the { ok, error } envelope runPythonTool returned), correlated by
// tool_call_id — so the judge can weigh whether the code actually ran.
type PythonAttempt = { code: string; ok: boolean; error?: string };

function extractPythonAttempts(messages: ChatMessage[]): PythonAttempt[] {
  const codeByCallId = new Map<string, string>();
  const attempts: PythonAttempt[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== "function" || tc.function.name !== "run_python") continue;
        let code = "";
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          code = typeof args?.code === "string" ? args.code : "";
        } catch {
          code = "";
        }
        codeByCallId.set(tc.id, code);
      }
    } else if (m.role === "tool") {
      // Tool results follow their assistant call, so the code is already mapped.
      const code = codeByCallId.get(m.tool_call_id);
      if (code === undefined) continue; // not a run_python result
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      let ok = false;
      let error: string | undefined;
      try {
        const env = JSON.parse(content) as { ok?: unknown; error?: unknown };
        ok = env?.ok === true;
        error = typeof env?.error === "string" ? env.error : undefined;
      } catch {
        // Non-JSON result — treat as a failed attempt with no parsed error.
      }
      attempts.push({ code, ok, error });
    }
  }
  return attempts;
}

// LLM-judge code quality: when the model wrote Python via run_python, grade how
// good that code was — correct for the request, compatible with the Monty
// sandbox's restricted Python, reading the injected `weather` rather than
// retyping data, and clear. The judge sees each script and whether it actually
// executed. Returns null (skips the score) when no Python was run, so runs that
// never needed analysis don't dilute the metric — mirroring scoreToolCallValidity.
export async function scorePythonCodeQuality(
  step: Step,
  prompt: string,
  messages: ChatMessage[],
): Promise<Score | null> {
  const attempts = extractPythonAttempts(messages);
  if (attempts.length === 0) return null;

  const listing = attempts
    .map(
      (a, i) =>
        `# Script ${i + 1} — executed ${a.ok ? "successfully" : `with an error: ${a.error ?? "unknown"}`}\n${a.code}`,
    )
    .join("\n\n");

  const rubric = `You are grading the QUALITY of Python code an assistant wrote to analyze weather data for a user request.

The code runs in a restricted sandbox (Monty): only the json, datetime, and re standard-library modules are importable, there are NO third-party packages (no numpy, pandas, statistics), no classes, and no match statements. The weather readings are pre-injected as a variable \`weather\` — a list of { city, unit, current, daily: [{ date, highC, lowC, humidity, windKph, precipMm, condition }] } — so the code should read \`weather\` rather than hardcoding data, and print() its results.

User request: ${prompt}

Python the assistant ran:
${listing}

Grade overall code quality on: (1) correctness — computes what the request needs and ran without error; (2) sandbox-compatibility — no forbidden imports/constructs (numpy/pandas/classes/match); (3) uses the injected \`weather\` variable instead of retyping data; (4) clarity — sensible loops/comprehensions and builtins, readable printed output. 1 = clean, correct, idiomatic sandbox-compatible code; 0 = broken, uses unavailable libraries, or hardcodes data.

Reply with ONLY {"score": <0-1>, "reason": "<one sentence>"}.`;
  return judge(step, "python-code-quality", rubric);
}
