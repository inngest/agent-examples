import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import { buildBrief, SYSTEM_PROMPT } from "../lib/prompt.js";
import { commitAll, headMessage, headSha, isDirty, resetHard } from "../lib/git.js";
import { backend, filesRef } from "../lib/backend.js";
import { localFsStore, memoryStore, type FileStore } from "../lib/file-store.js";
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
  // The function this attempt should work on (see pickFocus); unset = whole report.
  focus: z.object({ fn: z.string(), failed: z.number(), total: z.number() }).optional(),
  stubs: z.array(z.string()).optional(), // functions failing every case (see unimplemented)
  humanNote: z.string().optional(),
  best: z.object({ failed: z.number(), total: z.number() }),
  model: z.string(),
  maxTurns: z.number(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  maxTokensPerTurn: z.number(),
  reasoningMaxTokens: z.number().optional(),
  // From the model profile (goal-loop): whether `reasoning` may be sent at all,
  // and the most the turn budget may grow to.
  supportsReasoning: z.boolean().optional(),
  maxTokensCap: z.number().optional(),
  // Where earlier attempts' reasoning ladder ended up (see below), so this one
  // starts there instead of finding out again.
  start: z.object({ maxTokens: z.number().optional(), reasoningOff: z.boolean().optional() }).optional(),
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

// Every .ts file under src/, keyed by its path relative to src/.
async function snapshot(store: FileStore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of (await store.list()).filter((f) => f.endsWith(".ts")).sort()) {
    const g = await store.resolve(p, false);
    if ("key" in g) out[p] = await store.read(g.key);
  }
  return out;
}

// Cut off at the token limit with at least half the output spent reasoning.
const cutOffThinking = (res: ChatResponse): boolean => {
  const out = res.usage?.completion_tokens ?? 0;
  const reasoning = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return res.choices?.[0]?.finish_reason === "length" && out > 0 && reasoning >= out / 2;
};

// Most the ladder grows a turn's budget to when the model profile states no limit.
const MAX_TOKENS_CAP = 32_000;
// OpenRouter's way of turning reasoning off; honoured where budgets and low
// efforts weren't (mistral-large-4-0: 0 reasoning tokens, a tool call in 24s).
const REASONING_OFF = { enabled: false } as const;

// The call timeout grows with the budget: a slow provider (~100 tok/s) needs
// ~3 minutes for 16k tokens. Never below MODEL_TIMEOUT_MS (default 180s).
const turnTimeoutMs = (budget: number) => Math.max(Number(process.env.MODEL_TIMEOUT_MS) || 180_000, budget * 15);

// What to say after a turn without a tool call. A cut-off turn that was
// mostly reasoning (mistral-large-4-0 at 4,000 tokens: 3,084-3,909 of them
// reasoning, every turn) needs "stop thinking and act", not "make a smaller
// edit": its reasoning isn't kept, so the next turn would think from scratch.
const idleNudge = (res: ChatResponse): string => {
  if (res.choices?.[0]?.finish_reason !== "length") return "Use the tools, then call finish_attempt.";
  const out = res.usage?.completion_tokens ?? 0;
  const reasoning = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (cutOffThinking(res))
    return `You ran out of room for this turn while thinking (${reasoning} of ${out} output tokens were reasoning), so no tool call was made, and that reasoning is not kept. Keep your thinking short and make the tool call right away. If the whole change doesn't fit, make the first part of it with edit_file now.`;
  return "Your output was cut off before you made a tool call. Make a smaller edit with edit_file instead.";
};

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
      focus,
      stubs,
      humanNote,
      best,
      model,
      maxTurns,
      reasoningEffort,
      maxTokensPerTurn,
      reasoningMaxTokens,
      supportsReasoning = true,
      maxTokensCap = MAX_TOKENS_CAP,
      start,
    } = event.data;

    // OpenRouter treats reasoning.effort and reasoning.max_tokens as mutually
    // exclusive. Prefer the token budget (effort is not reliably honored), and
    // keep it under max_tokens (clamp to half) so reasoning can't eat the whole
    // output budget and leave no room for the tool call.
    // Both are opt-in; with neither set, no `reasoning` field is sent at all.
    // Not every model honours either (see the reasoning ladder below).
    const configuredReasoning = (budget: number) =>
      reasoningMaxTokens !== undefined
        ? { max_tokens: Math.min(reasoningMaxTokens, Math.floor(budget / 2)) }
        : reasoningEffort !== undefined
          ? { effort: reasoningEffort }
          : undefined;

    // Must be first: every attempt starts from the best commit with a clean tree.
    // Sandbox backend: no git. The workspace is a map held in step state: it is
    // seeded here and updated only from tool-step return values, never mutated
    // inside a step, so replay rebuilds it exactly.
    const sandbox = backend() === "sandbox";
    const files = new Map<string, string>();
    // `code` is the starting source, inlined in the brief (see buildBrief).
    // Local: read in the step after the reset, so replay sees the same text.
    // (A run that prepared before this field existed just gets no code.)
    let code: Record<string, string> | undefined;
    if (sandbox) {
      const seed = await step.run("prepare", async () => {
        await liveAttemptInStep(goalId, { type: "attempt.started", i });
        return { seed: bestFiles ?? {} };
      });
      for (const [p, c] of Object.entries(seed.seed)) files.set(p, c);
      code = Object.fromEntries(files);
    } else {
      const prepared: { reset: string; code?: Record<string, string> } = await step.run("prepare", async () => {
        await liveAttemptInStep(goalId, { type: "attempt.started", i });
        await resetHard(bestCommit);
        return { reset: bestCommit, code: await snapshot(localFsStore) };
      });
      code = prepared.code;
    }

    // The whole history is rebuilt from step return values only, so a replay
    // reconstructs exactly the same messages.
    const messages: Msg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildBrief({ i, best, humanNote, report, examples, journal, regressions, focus, stubs, code }) },
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
    // Reasoning ladder. A turn cut off while mostly reasoning gets, in order:
    // the nudge (idleNudge); a doubled turn budget (up to maxTokensCap); then
    // reasoning off. Caps can't be trusted: mistral-large-4-0 ignored a
    // 1,500-token reasoning budget and effort "low" and thought past 18k
    // tokens, but with reasoning off it wrote the whole port in one turn.
    // Off works whatever kind of control a model has, so an attempt always
    // gets to act. Derived from memoized responses only, so replay matches.
    let budget = Math.min(maxTokensCap, Math.max(maxTokensPerTurn, start?.maxTokens ?? 0));
    let reasoningOff = supportsReasoning && start?.reasoningOff === true;
    let thinkingCutoffs = 0;
    let raised = false;
    let escalated = false;
    let escalationWorked = false;
    for (let t = 1; turns < maxTurns && idleTurns < MAX_IDLE_TURNS && !summary; t++) {
      // Derived only from loop variables, so replay rebuilds identical messages.
      if (turns === maxTurns - 1 && !warnedLastTurn) {
        warnedLastTurn = true;
        messages.push({
          role: "user",
          content: "This is your last turn. Call finish_attempt now with a one-line summary of what you changed.",
        });
      }
      const turnReasoning = !supportsReasoning ? undefined : reasoningOff ? REASONING_OFF : configuredReasoning(budget);
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
          ...(turnReasoning ? { reasoning: turnReasoning } : {}),
          max_tokens: budget,
        };
      // Same step id either way, and both return the OpenAI response shape, so
      // switching MODEL_CALL doesn't break replay of a run in flight.
      const label = `${goalId} #${i} turn-${t}`;
      const res: ChatResponse =
        modelCallMode() === "worker"
          ? ((await step.ai.wrap(
              `turn-${t}`,
              modelCaller({ baseURL: baseUrl, apiKey, label, logger, timeoutMs: turnTimeoutMs(budget) }),
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
        // A turn with neither text nor a tool call (all reasoning, or cut off
        // before either) can't go back as content null: stricter providers
        // reject the next request with a non-retriable 400 ("Assistant message
        // must have either content or tool_calls"). Dropping the turn instead
        // would put two user messages in a row, which strict chat templates
        // also reject, so it gets a placeholder.
        content: msg?.content || (calls.length ? null : "(no output)"),
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
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens,
        maxTokens: budget,
        ...(reasoningOff ? { reasoningOff: true } : {}),
        inputTokens: res.usage?.prompt_tokens ?? 0,
        provider: (res as { provider?: string }).provider,
      });

      if (calls.length === 0) {
        idleTurns++;
        if (cutOffThinking(res)) {
          thinkingCutoffs++;
          // The first one only gets the nudge; after that, one rung per cut-off.
          if (thinkingCutoffs >= 2 && !raised && budget < maxTokensCap) {
            raised = escalated = true;
            budget = Math.min(maxTokensCap, budget * 2);
            logger.warn(`[${label}] cut off while reasoning again: turn budget → ${budget}`);
          } else if (thinkingCutoffs >= 2 && supportsReasoning && !reasoningOff) {
            reasoningOff = escalated = true;
            logger.warn(`[${label}] cut off while reasoning again: reasoning off for the rest of the attempt`);
          }
        }
        messages.push({ role: "user", content: idleNudge(res) });
        continue;
      }
      turns++;
      if (escalated) escalationWorked = true;

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

    // What the ladder settled on, if it had to climb and the model then acted:
    // goal-loop starts the next attempts there.
    const learned = escalationWorked ? { maxTokens: budget, reasoningOff } : undefined;
    return {
      commit: committed.commit,
      changed: committed.changed,
      files: "files" in committed ? committed.files : undefined,
      summary,
      turns,
      idleTurns,
      tokens,
      finished,
      costUsd,
      ...(learned ? { learned } : {}),
    };
  },
);
