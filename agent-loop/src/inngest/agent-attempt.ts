import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import { buildBrief, SYSTEM_PROMPT } from "../lib/prompt.js";
import { commitAll, headMessage, headSha, isDirty, resetHard } from "../lib/git.js";
import { backend, filesRef } from "../lib/backend.js";
import { localFsStore, memoryStore } from "../lib/file-store.js";
import { liveAttempt, liveAttemptInStep } from "../lib/live.js";
import { excerpt } from "./channel.js";
import { modelCallMode, modelCaller, type ChatResponse } from "../lib/model-call.js";

const AttemptInput = z.object({
  goalId: z.string(),
  i: z.number(),
  bestCommit: z.string(),
  bestFiles: z.record(z.string(), z.string()).optional(), // sandbox backend only: the best files to start from
  report: z.string(),
  // Attempt-to-attempt context (see buildBrief): the best result's example
  // pool, recent attempts, and what the last reverted attempt broke.
  examples: z.array(z.string()).optional(),
  journal: z
    .array(
      z.object({
        i: z.number(),
        outcome: z.enum(["kept", "reverted", "unchanged", "failed"]),
        failed: z.number(),
        summary: z.string(),
        delta: z.record(z.string(), z.number()).optional(),
      }),
    )
    .optional(),
  regressions: z.object({ i: z.number(), count: z.number(), examples: z.array(z.string()) }).optional(),
  humanNote: z.string().optional(),
  best: z.object({ failed: z.number(), total: z.number() }),
  model: z.string(),
  maxTurns: z.number(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  maxTokensPerTurn: z.number(),
  reasoningMaxTokens: z.number().optional(),
});

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// Cap on turns that end without a tool call, per attempt (see the turn loop).
const MAX_IDLE_TURNS = 4;
// finish_attempt before any write/edit is refused this many times per attempt:
// small models otherwise "finish" with a plan ("need to make focused edits")
// and the attempt is a no-change stall. After the cap, a finish is accepted.
const MAX_EMPTY_FINISH_REFUSALS = 2;
const EMPTY_FINISH_REFUSAL =
  "error: you haven't changed any file in this attempt, so there is nothing to finish. Make the change now with edit_file or write_file, then call finish_attempt.";

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

const isJsonObject = (s: string) => {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};

export const agentAttempt = inngest.createFunction(
  { id: "agent-attempt", retries: 2, triggers: [invoke(AttemptInput)] },
  async ({ event, step, logger }) => {
    const {
      goalId,
      i,
      bestCommit,
      bestFiles,
      report,
      examples,
      journal,
      regressions,
      humanNote,
      best,
      model,
      maxTurns,
      reasoningEffort,
      maxTokensPerTurn,
      reasoningMaxTokens,
    } = event.data;

    // OpenRouter treats reasoning.effort and reasoning.max_tokens as mutually
    // exclusive. Prefer the token budget (effort is not reliably honored), and
    // keep it under max_tokens (clamp to half) so reasoning can't eat the whole
    // output budget and leave no room for the tool call.
    // Both are opt-in; with neither set, no `reasoning` field is sent at all.
    const reasoning =
      reasoningMaxTokens !== undefined
        ? { max_tokens: Math.min(reasoningMaxTokens, Math.floor(maxTokensPerTurn / 2)) }
        : reasoningEffort !== undefined
          ? { effort: reasoningEffort }
          : undefined;

    // Must be first: every attempt starts from the best commit with a clean tree.
    // Sandbox backend: no git. The workspace is a map held in step state: it is
    // seeded here and updated only from tool-step return values, never mutated
    // inside a step, so replay rebuilds it exactly.
    const sandbox = backend() === "sandbox";
    const files = new Map<string, string>();
    if (sandbox) {
      const seed = await step.run("prepare", async () => {
        await liveAttemptInStep(goalId, { type: "attempt.started", i });
        return { seed: bestFiles ?? {} };
      });
      for (const [p, c] of Object.entries(seed.seed)) files.set(p, c);
    } else {
      await step.run("prepare", async () => {
        await liveAttemptInStep(goalId, { type: "attempt.started", i });
        await resetHard(bestCommit);
        return { reset: bestCommit };
      });
    }

    // The whole history is rebuilt from step return values only, so a replay
    // reconstructs exactly the same messages.
    const messages: Msg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildBrief({ i, best, humanNote, report, examples, journal, regressions }) },
    ];
    const tokens = { input: 0, output: 0 };
    let summary = "";
    let finished = false;
    let costUsd = 0;
    let turns = 0;

    const baseUrl = process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1/";
    const preferred = (process.env.MODEL_PROVIDERS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const providerRouting = preferred.length ? { order: preferred } : { sort: "throughput" };
    const apiKey = process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY;

    // `turns` counts turns that acted through a tool and is what maxTurns
    // budgets. Turns where the model answered in chat instead (about half of
    // them for small models, even with tool_choice "required") are counted
    // separately and capped, so they can't eat the budget or loop forever.
    // `t` numbers every model call and keeps step ids unique.
    let idleTurns = 0;
    let warnedLastTurn = false;
    // Both derived from memoized tool results only, so replay is deterministic.
    let edited = false;
    let emptyFinishRefusals = 0;
    for (let t = 1; turns < maxTurns && idleTurns < MAX_IDLE_TURNS && !summary; t++) {
      // Derived only from loop variables, so replay rebuilds identical messages.
      if (turns === maxTurns - 1 && !warnedLastTurn) {
        warnedLastTurn = true;
        messages.push({
          role: "user",
          content: "This is your last turn. Call finish_attempt now with a one-line summary of what you changed.",
        });
      }
      const body = {
          model,
          messages,
          tools: TOOLS,
          // Every turn must act through a tool; finish_attempt is the only way out.
          // Small models otherwise drift into writing code as chat text.
          tool_choice: "required",
          // OpenRouter otherwise may route to a provider that silently ignores
          // tool_choice; only route to providers that honour every parameter.
          // MODEL_PROVIDERS (comma-separated) pins a preference order: the same
          // model differs by provider (replaying one nemotron request: CoreWeave
          // ran away or re-listed files 5/5, Phala made the edit 5/5). Without
          // it, take the fastest: default routing once sent nemotron to an
          // 8 tok/s provider (a 9-minute turn) while another did 240 tok/s.
          ...(baseUrl.includes("openrouter.ai") ? { provider: { require_parameters: true, ...providerRouting } } : {}),
          ...(reasoning ? { reasoning } : {}),
          max_tokens: maxTokensPerTurn,
        };
      // Same step id either way, and both return the OpenAI response shape, so
      // switching MODEL_CALL doesn't break replay of a run in flight.
      const label = `${goalId} #${i} turn-${t}`;
      const res: ChatResponse =
        modelCallMode() === "worker"
          ? ((await step.ai.wrap(
              `turn-${t}`,
              modelCaller({ baseURL: baseUrl, apiKey, label, logger }),
              body,
            )) as ChatResponse)
          : ((await step.ai.infer(`turn-${t}`, {
              model: step.ai.models.openai({ model, baseUrl, apiKey }),
              body: body as never,
            })) as ChatResponse);

      tokens.input += res.usage?.prompt_tokens ?? 0;
      tokens.output += res.usage?.completion_tokens ?? 0;
      costUsd += (res.usage as { cost?: number } | undefined)?.cost ?? 0;

      const msg = res.choices?.[0]?.message;
      const calls = (msg?.tool_calls ?? []) as ToolCall[];
      // A call cut off mid-arguments (finish_reason "length") still runs and
      // gets the tool's "not valid JSON" error, but echoing the broken
      // arguments back makes providers reject the whole next request (400,
      // non-retriable), which fails the attempt. History gets "{}" instead.
      messages.push({
        role: "assistant",
        content: msg?.content ?? null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => (isJsonObject(c.function.arguments) ? c : { ...c, function: { ...c.function, arguments: "{}" } })) }
          : {}),
      });
      await liveAttempt(step, `live-turn-${t}`, goalId, {
        type: "turn",
        i,
        t,
        toolCalls: calls.length,
        finishReason: res.choices?.[0]?.finish_reason ?? "",
        text: excerpt(msg?.content),
        outputTokens: res.usage?.completion_tokens ?? 0,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        provider: (res as { provider?: string }).provider,
      });

      if (calls.length === 0) {
        idleTurns++;
        messages.push({
          role: "user",
          content:
            res.choices?.[0]?.finish_reason === "length"
              ? "Your output was cut off before you made a tool call. Make a smaller edit with edit_file instead."
              : "Use the tools, then call finish_attempt.",
        });
        continue;
      }
      turns++;

      for (let n = 0; n < calls.length; n++) {
        const call = calls[n]!;
        // `id` stays stable for memoization; `name` is display-only, so the
        // trace reads "tool-3-1: edit_file" without affecting replay.
        const id = `tool-${t}-${n + 1}`;
        const out = await step.run({ id, name: `${id}: ${call.function.name}` }, async () => {
          const r = await executeTool(
            sandbox ? memoryStore(Object.fromEntries(files)) : localFsStore,
            call.function.name,
            call.function.arguments,
          );
          await liveAttemptInStep(goalId, { type: "tool", i, t, n: n + 1, name: call.function.name, result: excerpt(r.result, 120) });
          logger.info(`[${goalId} #${i} ${id}] ${call.function.name} → ${excerpt(r.result, 160)}`);
          return r;
        });
        for (const [p, c] of Object.entries(out.changed ?? {})) files.set(p, c);
        if (/^(wrote|edited) /.test(out.result)) edited = true;
        if (out.finished !== undefined && !edited && emptyFinishRefusals < MAX_EMPTY_FINISH_REFUSALS) {
          emptyFinishRefusals++;
          await liveAttempt(step, `live-refused-${t}-${n + 1}`, goalId, { type: "finish.refused", i, t });
          messages.push({ role: "tool", tool_call_id: call.id, content: EMPTY_FINISH_REFUSAL });
          continue;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out.result });
        if (out.finished !== undefined) {
          summary = out.finished;
          finished = true;
          break;
        }
      }
    }

    if (!summary)
      summary =
        idleTurns >= MAX_IDLE_TURNS
          ? `(stopped after ${idleTurns} turns without a tool call)`
          : `(no finish_attempt after ${turns} turns)`;

    const committed = await step.run("commit", async () => {
      if (sandbox) {
        const out = Object.fromEntries(files);
        const commit = filesRef(out);
        return { commit, changed: commit !== bestCommit, files: out };
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

    return { commit: committed.commit, changed: committed.changed, files: "files" in committed ? committed.files : undefined, summary, turns, idleTurns, tokens, finished, costUsd };
  },
);
