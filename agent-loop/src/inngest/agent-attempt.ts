import { invoke } from "inngest";
import { z } from "zod";
import { inngest } from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import { excerpt } from "./channel.js";
import { buildBrief, SYSTEM_PROMPT, type BriefInput } from "../lib/prompt.js";
import { liveAttempt, liveAttemptInStep } from "../lib/live.js";
import { buildRequest, callModel, modelEndpoint } from "../lib/model-call.js";
import { assistantMessage, EMPTY_FINISH_REFUSAL, idleNudge, LAST_TURN_WARNING, toolCalls, type Msg } from "../lib/history.js";
import { ReasoningLadder, type Learned } from "../lib/reasoning-ladder.js";
import { workspace } from "../lib/workspace.js";

// What goal-loop knows about the best result so far, for the brief (the
// attempt adds `i` and the starting code).
export type AttemptBrief = Omit<BriefInput, "i" | "code">;

const Brief: z.ZodType<AttemptBrief, AttemptBrief> = z.object({
  best: z.object({ failed: z.number(), total: z.number() }),
  humanNote: z.string().optional(),
  report: z.string(),
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
  focus: z.object({ fn: z.string(), failed: z.number(), total: z.number() }).optional(),
  stubs: z.array(z.string()).optional(),
});

const AttemptInput = z.object({
  goalId: z.string(),
  i: z.number(),
  // Where this attempt starts: the best commit (sandbox: plus its files).
  start: z.object({ commit: z.string(), files: z.record(z.string(), z.string()).optional() }),
  brief: Brief,
  model: z.object({
    slug: z.string(),
    maxTurns: z.number(),
    maxTokensPerTurn: z.number(),
    // From the model profile: the most the turn budget may grow to, and
    // whether `reasoning` may be sent at all.
    maxTokensCap: z.number(),
    supportsReasoning: z.boolean(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    reasoningMaxTokens: z.number().optional(),
    // Where earlier attempts' reasoning ladders ended up, so this one starts there.
    learned: z.object({ maxTokens: z.number().optional(), reasoningOff: z.boolean().optional() }),
  }),
});

export type AttemptResult = {
  commit: string;
  changed: boolean;
  files?: Record<string, string>;
  summary: string;
  turns: number;
  idleTurns: number;
  tokens: { input: number; output: number };
  finished: boolean;
  costUsd: number;
  // Set when the attempt's reasoning ladder had to climb and the model then acted.
  learned?: Learned;
};

// A cancelled attempt resolves its invoke without a result, so goal-loop checks.
export const isAttemptResult = (x: unknown): x is AttemptResult => {
  const a = x as Partial<AttemptResult> | null | undefined;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.commit === "string" &&
    typeof a.changed === "boolean" &&
    typeof a.costUsd === "number" &&
    typeof a.tokens?.input === "number" &&
    typeof a.tokens?.output === "number"
  );
};

// Cap on turns that end without a tool call, per attempt.
const MAX_IDLE_TURNS = 4;
// finish_attempt before any write/edit is refused this many times per attempt;
// after the cap, a finish is accepted.
const MAX_EMPTY_FINISH_REFUSALS = 2;

// Replay: Inngest re-runs this function from the top on every step, returning
// memoized results for steps already done. So everything that decides control
// flow or the message history below is derived only from event data and step
// results, never from anything read outside a step.
export const agentAttempt = inngest.createFunction(
  { id: "agent-attempt", retries: 2, triggers: [invoke(AttemptInput)] },
  async ({ event, step, logger }): Promise<AttemptResult> => {
    const { goalId, i, start, brief, model } = event.data;

    // 1. Prepare the workspace. Must be first: every attempt starts from the
    // best commit with a clean tree.
    const ws = workspace().attempt(start);
    const prepared = await step.run("prepare", async () => {
      await liveAttemptInStep(goalId, { type: "attempt.started", i });
      return ws.prepare();
    });
    // The starting source, inlined in the brief.
    const code = ws.begin(prepared);

    // 2. The brief.
    const messages: Msg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildBrief({ i, ...brief, code }) },
    ];

    // 3. The turn loop. `turns` counts turns that acted through a tool and is
    // what maxTurns budgets; turns answered in chat instead are `idleTurns`,
    // capped separately so they can't eat the budget or loop forever. `t`
    // numbers every model call and keeps step ids unique.
    const ladder = new ReasoningLadder({
      effort: model.reasoningEffort,
      reasoningMaxTokens: model.reasoningMaxTokens,
      maxTokensPerTurn: model.maxTokensPerTurn,
      maxTokensCap: model.maxTokensCap,
      supportsReasoning: model.supportsReasoning,
      start: model.learned,
    });
    const { baseUrl, apiKey } = modelEndpoint();
    const tokens = { input: 0, output: 0 };
    let costUsd = 0;
    let turns = 0;
    let idleTurns = 0;
    let summary = "";
    let finished = false;
    let warnedLastTurn = false;
    let edited = false;
    let emptyFinishRefusals = 0;
    for (let t = 1; turns < model.maxTurns && idleTurns < MAX_IDLE_TURNS && !summary; t++) {
      if (turns === model.maxTurns - 1 && !warnedLastTurn) {
        warnedLastTurn = true;
        messages.push({ role: "user", content: LAST_TURN_WARNING });
      }

      // Call the model.
      const turn = ladder.turn();
      const label = `${goalId} #${i} turn-${t}`;
      const body = buildRequest({ model: model.slug, messages, tools: TOOLS, baseUrl, maxTokens: turn.maxTokens, reasoning: turn.reasoning });
      const res = await callModel(step, `turn-${t}`, body, { model: model.slug, baseUrl, apiKey, label, logger, timeoutMs: turn.timeoutMs });
      tokens.input += res.usage?.prompt_tokens ?? 0;
      tokens.output += res.usage?.completion_tokens ?? 0;
      costUsd += res.usage?.cost ?? 0;

      // Record it in history.
      const calls = toolCalls(res);
      messages.push(assistantMessage(res));
      await liveAttempt(step, `live-turn-${t}`, goalId, {
        type: "turn",
        i,
        t,
        toolCalls: calls.length,
        finishReason: res.choices?.[0]?.finish_reason ?? "",
        text: excerpt(res.choices?.[0]?.message?.content),
        outputTokens: res.usage?.completion_tokens ?? 0,
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens,
        maxTokens: turn.maxTokens,
        ...(turn.reasoningOff ? { reasoningOff: true } : {}),
        inputTokens: res.usage?.prompt_tokens ?? 0,
        provider: res.provider,
      });
      const climbed = ladder.observe(res);
      if (climbed) logger.warn(`[${label}] ${climbed}`);

      if (calls.length === 0) {
        idleTurns++;
        messages.push({ role: "user", content: idleNudge(res) });
        continue;
      }
      turns++;

      // Run the tools, each its own step.
      for (let n = 0; n < calls.length; n++) {
        const call = calls[n]!;
        // `id` stays stable for memoization; `name` is display-only, so the
        // trace reads "tool-3-1: edit_file" without affecting replay.
        const id = `tool-${t}-${n + 1}`;
        const out = await step.run({ id, name: `${id}: ${call.function.name}` }, async () => {
          const r = await executeTool(ws.store(), call.function.name, call.function.arguments);
          await liveAttemptInStep(goalId, { type: "tool", i, t, n: n + 1, name: call.function.name, result: excerpt(r.result, 120) });
          logger.info(`[${goalId} #${i} ${id}] ${call.function.name} → ${excerpt(r.result, 160)}`);
          return r;
        });
        ws.apply(out.changed);
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

    // 4. Commit.
    const committed = await step.run("commit", () => ws.commit(i, summary));

    // 5. Return. `learned` tells goal-loop where to start the next attempts' ladders.
    const learned = ladder.learned();
    return {
      commit: committed.commit,
      changed: committed.changed,
      files: committed.files,
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
