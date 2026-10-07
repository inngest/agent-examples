import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import { buildBrief, SYSTEM_PROMPT } from "../lib/prompt.js";
import { commitAll, headMessage, headSha, isDirty, resetHard } from "../lib/git.js";
import { backend, sourceRef } from "../lib/backend.js";
import { localFsStore, memoryStore } from "../lib/file-store.js";

// Sandbox backend: the agent's workspace is this in-memory map (paths relative
// to src/). The only entry that matters for scoring is semver.ts.
const MAIN_FILE = "semver.ts";

const AttemptInput = z.object({
  goalId: z.string(),
  i: z.number(),
  bestCommit: z.string(),
  bestSource: z.string().optional(), // sandbox backend only: the best source to start from
  report: z.string(),
  humanNote: z.string().optional(),
  best: z.object({ failed: z.number(), total: z.number() }),
  model: z.string(),
  maxTurns: z.number(),
  reasoningEffort: z.enum(["low", "medium", "high"]),
  maxTokensPerTurn: z.number(),
  reasoningMaxTokens: z.number().optional(),
});

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export const agentAttempt = inngest.createFunction(
  { id: "agent-attempt", retries: 2, triggers: [invoke(AttemptInput)] },
  async ({ event, step }) => {
    const { goalId, i, bestCommit, bestSource, report, humanNote, best, model, maxTurns, reasoningEffort, maxTokensPerTurn, reasoningMaxTokens } =
      event.data;

    // OpenRouter treats reasoning.effort and reasoning.max_tokens as mutually
    // exclusive. Prefer the token budget (effort is not reliably honored), and
    // keep it under max_tokens (clamp to half) so reasoning can't eat the whole
    // output budget and leave no room for the tool call.
    const reasoning =
      reasoningMaxTokens !== undefined
        ? { max_tokens: Math.min(reasoningMaxTokens, Math.floor(maxTokensPerTurn / 2)) }
        : { effort: reasoningEffort };

    // Must be first: every attempt starts from the best commit with a clean tree.
    // Sandbox backend: no git. The workspace is a map held in step state: it is
    // seeded here and updated only from tool-step return values, never mutated
    // inside a step, so replay rebuilds it exactly.
    const sandbox = backend() === "sandbox";
    const files = new Map<string, string>();
    if (sandbox) {
      const seed = await step.run("prepare", async () => ({ seed: bestSource ?? "" }));
      files.set(MAIN_FILE, seed.seed);
    } else {
      await step.run("prepare", async () => {
        await resetHard(bestCommit);
        return { reset: bestCommit };
      });
    }

    // The whole history is rebuilt from step return values only, so a replay
    // reconstructs exactly the same messages.
    const messages: Msg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildBrief({ i, best, humanNote, report }) },
    ];
    const tokens = { input: 0, output: 0 };
    let summary = "";
    let finished = false;
    let costUsd = 0;
    let turns = 0;

    const baseUrl = process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1/";
    const apiKey = process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY;

    for (let t = 1; t <= maxTurns && !summary; t++) {
      turns = t;
      // Derived only from loop variables, so replay rebuilds identical messages.
      if (t === maxTurns) {
        messages.push({
          role: "user",
          content: "This is your last turn. Call finish_attempt now with a one-line summary of what you changed.",
        });
      }
      const res = await step.ai.infer(`turn-${t}`, {
        model: step.ai.models.openai({ model, baseUrl, apiKey }),
        body: {
          messages,
          tools: TOOLS,
          reasoning,
          max_tokens: maxTokensPerTurn,
        } as never,
      });

      tokens.input += res.usage?.prompt_tokens ?? 0;
      tokens.output += res.usage?.completion_tokens ?? 0;
      costUsd += (res.usage as { cost?: number } | undefined)?.cost ?? 0;

      const msg = res.choices?.[0]?.message;
      const calls = (msg?.tool_calls ?? []) as ToolCall[];
      messages.push({
        role: "assistant",
        content: msg?.content ?? null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });

      if (calls.length === 0) {
        messages.push({
          role: "user",
          content:
            res.choices?.[0]?.finish_reason === "length"
              ? "Your output was cut off before you made a tool call. Make a smaller edit with edit_file instead."
              : "Use the tools, then call finish_attempt.",
        });
        continue;
      }

      for (let n = 0; n < calls.length; n++) {
        const call = calls[n]!;
        // `id` stays stable for memoization; `name` is display-only, so the
        // trace reads "tool-3-1: edit_file" without affecting replay.
        const id = `tool-${t}-${n + 1}`;
        const out = await step.run({ id, name: `${id}: ${call.function.name}` }, async () =>
          executeTool(
            sandbox ? memoryStore(Object.fromEntries(files)) : localFsStore,
            call.function.name,
            call.function.arguments,
          ),
        );
        for (const [p, c] of Object.entries(out.changed ?? {})) files.set(p, c);
        messages.push({ role: "tool", tool_call_id: call.id, content: out.result });
        if (out.finished !== undefined) {
          summary = out.finished;
          finished = true;
          break;
        }
      }
    }

    if (!summary) summary = `(no finish_attempt after ${turns} turns)`;

    const committed = await step.run("commit", async () => {
      if (sandbox) {
        const source = files.get(MAIN_FILE) ?? "";
        const commit = sourceRef(source);
        return { commit, changed: commit !== bestCommit, source };
      }
      const prefix = `attempt ${i}: `;
      const head = await headSha();
      // Idempotent retry: a previous try already committed this attempt.
      if (head !== bestCommit && (await headMessage()).startsWith(prefix) && !(await isDirty())) {
        return { commit: head, changed: true };
      }
      if (await isDirty()) {
        const commit = await commitAll(prefix + oneLine(summary, 120));
        return { commit, changed: true };
      }
      return { commit: bestCommit, changed: false };
    });

    return { commit: committed.commit, changed: committed.changed, source: "source" in committed ? committed.source : undefined, summary, turns, tokens, finished, costUsd };
  },
);
