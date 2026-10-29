import type OpenAI from "openai";
import { NonRetriableError, type GetStepTools, type Logger } from "inngest";
import { toolDefinitions, executeTool } from "./tools";
import { openrouter } from "./openrouter";
import { inngest } from "../inngest/client";
import { chatChannel, type ChatMessage } from "../inngest/channel";

// Tuned for the OpenRouter models the experiment buckets into (see MODEL_A /
// MODEL_B in chat-function.ts): explicit trigger conditions per tool (so the
// models reach for tools instead of answering from memory), parallel calls
// encouraged, and output style matched to the UI, which renders Markdown.
const SYSTEM_PROMPT = `You are a friendly assistant in a live chat UI.

When a question involves current weather, temperature unit conversion, or the current date or time — including follow-up questions later in the conversation — call the matching tool (get_weather, get_weather_multi, convert_to_celsius, convert_to_fahrenheit, get_current_time) and answer from its result. get_weather reports Celsius; when the user wants Fahrenheit, follow it with convert_to_fahrenheit rather than converting yourself. For weather in several cities, you can call get_weather once per city or get_weather_multi with all of them at once. When one message asks about several independent things, call the tools in parallel in a single turn. Answer everything else directly from your own knowledge.

When answering a weather question needs computation over the daily history — trends, averages or other aggregates, correlations, or filtering across the ~30-day series — call run_python with the relevant cities and a short script. The readings arrive as a variable \`weather\` (a list of the same objects get_weather_multi returns) and whatever your script prints comes back to you. This runs in a restricted interpreter: only the json, datetime, and re modules can be imported, and there are no third-party packages (no numpy or pandas), no classes, and no match statements — use plain loops, comprehensions, and builtins.

Keep replies short and conversational: a sentence or two, more only when the question genuinely needs it. The chat renders Markdown, so you may use light formatting — short lists, **bold**, \`code\`, and small tables — when it genuinely makes an answer clearer, but skip it for simple one- or two-line replies.`;

// Batch window for streamed token deltas: each publish is one HTTP POST, so
// this trades a little latency for far fewer round trips than publishing
// per-character.
const BATCH_MS = 40;

// Belt-and-suspenders against a runaway tool-use loop (e.g. a model that
// never stops calling tools) — bounds both cost and worst-case run time.
const MAX_TURNS = 8;

// Per-response output cap sent as the API `max_tokens`. Configurable so it can
// be tuned per deployment; also published on `turn.completed` (as `maxTokens`)
// so the UI can reserve it from the context window when drawing the meter.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 11496;

// The browser keeps every realtime status message and re-derives its view on
// each one, so an unbounded tool payload — a big multi-city weather blob, or a
// dataset a model inlined into a run_python `code` argument — bloats the tab and
// can OOM it. Clip what's PUBLISHED to the UI; the model still receives the full
// tool output in history (see the `messages.push` below), so answer quality is
// unaffected — only the live trace view is bounded.
const UI_MAX_CHARS = 4000;

function clipUiString(s: string): string {
  return s.length > UI_MAX_CHARS ? `${s.slice(0, UI_MAX_CHARS)}…[${s.length - UI_MAX_CHARS} more chars]` : s;
}

// Deep-clip every string in a tool input (arguments the model emitted) for the
// UI copy, leaving structure intact so the trace still shows shape.
function clipUiInput(value: unknown): unknown {
  if (typeof value === "string") return clipUiString(value);
  if (Array.isArray(value)) return value.map(clipUiInput);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipUiInput(v);
    return out;
  }
  return value;
}

type Step = GetStepTools<typeof inngest>;
type Channel = ReturnType<typeof chatChannel>;

// One tool call the model asked for this turn. `arguments` is the raw JSON
// string (replayed verbatim in the assistant message so history stays valid);
// `input` is the parsed object (passed to executeTool and used by the
// tool-efficiency scorer). `parsedOk` records whether the model emitted
// well-formed JSON arguments — a tool-emit-quality signal the validity scorer
// reads.
type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
  input: unknown;
  parsedOk: boolean;
};

type TurnResult = {
  text: string;
  toolCalls: PendingToolCall[];
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
};

// Runs one model turn as a single durable step. Streaming to the browser is a
// side effect of that step (non-durable `inngest.realtime.publish` calls) —
// if the step retries, it re-streams from `seq: 0` and the UI resets that
// turn's buffer (see Chat.tsx); once the step completes, it's memoized and
// never re-streams or re-calls the model again.
async function streamTurn(
  step: Step,
  ch: Channel,
  turn: number,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  model: string,
): Promise<TurnResult> {
  const result = await step.run(`llm-turn-${turn}`, async () => {
    let seq = 0;
    // `buffer` holds only the current un-published batch (cleared on flush);
    // `fullText` accumulates the whole turn for the durable `turn.completed`
    // fallback and the recorded assistant message.
    let buffer = "";
    let fullText = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending: Promise<unknown>[] = [];

    const flush = () => {
      if (!buffer) return;
      const delta = buffer;
      buffer = "";
      timer = null;
      // Non-durable and non-blocking: this is a live UI nicety, not part of
      // the durable record. `turn.completed` (below, durable) is the
      // authoritative text the UI falls back to if any deltas are lost. Each
      // publish is caught individually — a dropped batch is recoverable, but
      // an unhandled rejection is fatal under Node's default settings — and
      // tracked in `pending` so the step doesn't settle with publishes still
      // in flight (a serverless runtime may freeze the instance as soon as
      // the handler returns, silently dropping the tail of the stream).
      pending.push(
        inngest.realtime.publish(ch.tokens, { turn, seq: seq++, delta }).catch(() => {}),
      );
    };

    const stream = await openrouter.chat.completions.create({
      model,
      // Per-response output cap (configurable via MAX_OUTPUT_TOKENS). Leaves
      // room for parallel tool calls plus a final answer in one turn while
      // keeping worst-case cost bounded alongside MAX_TURNS.
      max_tokens: MAX_OUTPUT_TOKENS,
      messages,
      tools: toolDefinitions,
      stream: true,
      // OpenRouter only returns token usage on a trailing usage-only chunk
      // when this is set — the UI's context meter depends on it.
      stream_options: { include_usage: true },
    });

    // Tool-call deltas arrive fragmented across chunks, keyed by `index`: the
    // first carries id + name, later ones append to `arguments`. Accumulate by
    // index, then parse once the stream ends.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue; // usage-only trailing chunk has no choices

        if (choice.delta.content) {
          buffer += choice.delta.content;
          fullText += choice.delta.content;
          timer ??= setTimeout(flush, BATCH_MS);
        }

        for (const tc of choice.delta.tool_calls ?? []) {
          let acc = toolAcc.get(tc.index);
          if (!acc) {
            acc = { id: "", name: "", args: "" };
            toolAcc.set(tc.index, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const toolCalls: PendingToolCall[] = [...toolAcc.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, acc]) => {
          // A parse failure is a model-output problem, not a transient one, so
          // fall back to an empty object rather than throwing (which would
          // retry the step and reproduce the same unparseable args). The tool
          // handlers coerce/validate their own inputs. Empty args are valid
          // for a no-parameter tool, so only a JSON.parse failure counts as a
          // malformed emit — `parsedOk` records it so the validity scorer can
          // catch models that emit broken tool-call arguments.
          let input: unknown = {};
          let parsedOk = true;
          try {
            input = acc.args ? JSON.parse(acc.args) : {};
          } catch {
            input = {};
            parsedOk = false;
          }
          return { id: acc.id, name: acc.name, arguments: acc.args || "{}", input, parsedOk };
        });

      return { text: fullText, toolCalls, finishReason, usage } satisfies TurnResult;
    } finally {
      // Always cancel a pending batch so no flush fires after the step
      // settles — on failure, a stray timer would otherwise publish stale
      // tokens into the retry's fresh stream.
      if (timer) clearTimeout(timer);
      flush();
      // Never rejects — every promise in `pending` is already caught.
      await Promise.all(pending);
    }
  });

  return result as unknown as TurnResult;
}

// Carries the emit-quality signal (`argsRaw`, `parsedOk`) alongside the parsed
// input so the tool-call-validity scorer can grade how well each model emits
// tool calls — see scorers.ts.
export type ToolCall = { name: string; input: unknown; argsRaw: string; parsedOk: boolean };

export async function runChatAgent(
  step: Step,
  sessionId: string,
  history: ChatMessage[],
  model: string,
  contextWindow: number,
  variant: string,
  logger: Logger,
): Promise<{ text: string; toolCalls: ToolCall[]; newMessages: ChatMessage[] }> {
  const ch = chatChannel(sessionId);
  // The worker owns the system prompt (the client transcript never includes
  // it), so it's prepended fresh on every request.
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];
  // Everything from here on is new — recorded so `newMessages` (published
  // alongside `run.completed`) can hand the client exactly what this run
  // appended, without re-sending history the client already has (or the
  // system message, which the worker adds itself).
  const historyLength = messages.length;

  // The most recent turn that produced visible text. Some models emit their
  // prose in the same turn as their tool calls and then return an *empty* final
  // turn after the tool results — so the last turn's text can be "" even though
  // the model did answer. Tracking the last non-empty text lets the run surface
  // that answer instead of committing a blank reply (the bubble, recovery via
  // /api/run-status, and the judge scores all read the returned `text`).
  let lastNonEmptyText = "";
  const toolCalls: ToolCall[] = [];

  await step.realtime.publish("run-started", ch.status, { type: "run.started", variant, model });
  // Logs go through the Inngest ctx logger (passed from the handler), which
  // de-duplicates across step memoization/retries — plain console.log here
  // would repeat on every function resume.
  logger.info("agent: run start", { sessionId, variant, model });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await streamTurn(step, ch, turn, messages, model);
      const text = response.text;
      if (text.trim()) lastNonEmptyText = text;

      logger.info("agent: turn done", {
        turn,
        finishReason: response.finishReason,
        outputTokens: response.usage.outputTokens,
        toolCalls: response.toolCalls.length,
      });

      const usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        contextWindow,
        // Published so the UI can reserve the output budget from the window.
        maxTokens: MAX_OUTPUT_TOKENS,
      };

      // A "length" cutoff can't be treated as a clean finish: the model was
      // cut off mid-turn, so any tool_calls it started may be incomplete. An
      // assistant message with unmatched tool_calls makes the replayed history
      // invalid on the next request, so record a text-only assistant turn (a
      // visible truncation marker) instead and surface it.
      if (response.finishReason === "length") {
        const marker = "\n\n[Response truncated — output token limit reached.]";
        const finalText = text ? text + marker : marker;
        messages.push({ role: "assistant", content: finalText });
        await step.realtime.publish(`turn-completed-${turn}`, ch.status, {
          type: "turn.completed",
          turn,
          text,
          usage,
        });
        const newMessages = messages.slice(historyLength);
        await step.realtime.publish("run-completed", ch.status, {
          type: "run.completed",
          text: finalText,
          newMessages,
        });
        return { text: finalText, toolCalls, newMessages };
      }

      const hasToolCalls = response.finishReason === "tool_calls" && response.toolCalls.length > 0;

      // Record the assistant turn exactly as the API shape requires: an
      // assistant message carrying its `tool_calls` (content null when it only
      // called tools), which the tool-result messages below must then answer.
      messages.push(
        hasToolCalls
          ? {
              role: "assistant",
              content: text || null,
              tool_calls: response.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : { role: "assistant", content: text },
      );

      await step.realtime.publish(`turn-completed-${turn}`, ch.status, {
        type: "turn.completed",
        turn,
        text,
        usage,
      });

      // Anything that isn't a tool-call turn ends the run — including finish
      // reasons this SDK version doesn't know about yet. Treating "unknown" as
      // "done" is the safe default: it surfaces whatever text came back instead
      // of looping forever waiting for a tool call that isn't coming.
      if (!hasToolCalls) {
        // Fall back to the last turn that actually produced text: a model that
        // said its piece alongside its tool calls and then returned an empty
        // final turn would otherwise commit a blank bubble.
        const finalText = text.trim() ? text : lastNonEmptyText;
        const newMessages = messages.slice(historyLength);
        await step.realtime.publish("run-completed", ch.status, {
          type: "run.completed",
          text: finalText,
          newMessages,
        });
        return { text: finalText, toolCalls, newMessages };
      }

      for (let i = 0; i < response.toolCalls.length; i++) {
        const call = response.toolCalls[i]!;
        toolCalls.push({
          name: call.name,
          input: call.input,
          argsRaw: call.arguments,
          parsedOk: call.parsedOk,
        });

        logger.info("agent: tool call", { turn, name: call.name, input: call.input });
        await step.realtime.publish(`tool-called-${turn}-${i}`, ch.status, {
          type: "tool.called",
          turn,
          name: call.name,
          input: clipUiInput(call.input),
        });

        const output = await step.run(`tool-${call.name}-${turn}-${i}`, () =>
          executeTool(call.name, call.input),
        );

        await step.realtime.publish(`tool-result-${turn}-${i}`, ch.status, {
          type: "tool.result",
          turn,
          name: call.name,
          output: clipUiString(output),
        });

        // Each tool_call must be answered by a `tool` message carrying its
        // `tool_call_id`, or the next request's history is invalid.
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }

    // Turn cap reached without a natural stop: surface whatever the last turn
    // produced instead of hanging or silently truncating. This path always
    // ends on `tool` messages (the loop just pushed them at the bottom of the
    // last iteration), which is valid history on its own.
    const fallbackText = lastNonEmptyText || "(turn limit reached without a final response)";
    const newMessages = messages.slice(historyLength);
    await step.realtime.publish("run-completed", ch.status, {
      type: "run.completed",
      text: fallbackText,
      newMessages,
    });
    return { text: fallbackText, toolCalls, newMessages };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("agent: run failed", { sessionId, variant, model, error });
    // The UI is *not* notified here: this catch runs on every failed attempt,
    // and the run may still retry and succeed. The terminal `run.failed` notice
    // is published exactly once from the function's `onFailure` handler (see
    // chat-function.ts), after all retries are exhausted — so a transient error
    // no longer surfaces as a permanent failure the client commits early.
    //
    // Retry classification: the OpenRouter/OpenAI SDK throws with a numeric
    // `.status`. A 4xx (except 429 rate-limit) is a bad request — invalid
    // history, unknown model — that will fail identically on retry, so fail
    // fast to `onFailure` instead of burning the whole retry budget. 5xx,
    // network errors, and 429 stay retriable (rethrown as-is).
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
      throw new NonRetriableError(`model request rejected (${status}): ${error}`);
    }
    throw err;
  }
}
