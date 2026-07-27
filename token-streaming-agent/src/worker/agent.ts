import Anthropic from "@anthropic-ai/sdk";
import type { GetStepTools } from "inngest";
import { toolDefinitions, executeTool } from "./tools";
import { inngest } from "../inngest/client";
import { chatChannel, type ChatMessage } from "../inngest/channel";

// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the
// environment itself, so no manual client configuration is needed here.
const client = new Anthropic();

// Tuned for Claude (Haiku through Opus): explicit trigger conditions per tool
// (recent Claude models reach for tools conservatively unless told when),
// parallel calls encouraged, and output style matched to the UI, which
// renders plain text — markdown would show up as literal asterisks.
const SYSTEM_PROMPT = `You are a friendly assistant in a live chat UI.

When a question involves current weather, temperature unit conversion, or the current date or time — including follow-up questions later in the conversation — call the matching tool (get_weather, convert_to_celsius, convert_to_fahrenheit, get_current_time) and answer from its result. get_weather reports Celsius; when the user wants Fahrenheit, follow it with convert_to_fahrenheit rather than converting yourself. When one message asks about several independent things, call the tools in parallel in a single turn. Answer everything else directly from your own knowledge.

Keep replies short and conversational: a sentence or two, more only when the question genuinely needs it. The chat renders plain text, so write prose without markdown formatting, headings, or tables.`;

// Batch window for streamed token deltas: each publish is one HTTP POST, so
// this trades a little latency for far fewer round trips than publishing
// per-character.
const BATCH_MS = 40;

// Belt-and-suspenders against a runaway tool-use loop (e.g. a model that
// never stops calling tools) — bounds both cost and worst-case run time.
const MAX_TURNS = 8;

// Both experiment variants (Haiku 4.5 and Opus 4.8, see chat-function.ts) are
// 200k-context models. Published with per-turn usage so the UI's context
// meter needs no model knowledge; revisit if a variant changes.
const CONTEXT_WINDOW = 200_000;

type Step = GetStepTools<typeof inngest>;
type Channel = ReturnType<typeof chatChannel>;

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Runs one model turn as a single durable step. Streaming to the browser is a
// side effect of that step (non-durable `inngest.realtime.publish` calls) —
// if the step retries, it re-streams from `seq: 0` and the UI resets that
// turn's buffer (see Chat.tsx); once the step completes, it's memoized and
// never re-streams or re-calls the model again.
async function streamTurn(
  step: Step,
  ch: Channel,
  turn: number,
  messages: Anthropic.MessageParam[],
  model: string,
): Promise<Anthropic.Message> {
  const result = await step.run(`llm-turn-${turn}`, async () => {
    let seq = 0;
    let buffer = "";
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

    const stream = client.messages.stream({
      model,
      // Both experiment variants (Haiku 4.5 and Opus 4.8) stream and support
      // ≥64K max output tokens; 16K leaves ample room for ~20 parallel tool
      // calls plus a long final answer in one turn while keeping worst-case
      // cost bounded alongside MAX_TURNS.
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages,
    });

    stream.on("text", (delta) => {
      buffer += delta;
      timer ??= setTimeout(flush, BATCH_MS);
    });

    try {
      return await stream.finalMessage();
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

  // step.run JSON-round-trips the result, but it's really this shape.
  return result as unknown as Anthropic.Message;
}

// A max_tokens cutoff (or, at the bottom of the loop, the MAX_TURNS cap) can
// leave `tool_use` blocks in the recorded history with no matching
// `tool_result` — the block was cut off mid-emission, or stripped above
// because it was incomplete. The API rejects a replayed history containing
// an orphaned tool_use block, so this drops any block whose id has no
// matching tool_result anywhere in the run, and drops a message entirely if
// that empties its content — both are required before `newMessages` is
// handed to the client for replay on the next request.
//
// The reverse direction — a tool_result whose tool_use is missing — is
// unhandled by design: it's unreachable today because a tool_result is only
// ever pushed immediately after executing its tool_use within the same run
// (an executeTool failure aborts to run.failed before newMessages is ever
// published). If the loop ever records results across runs or skips a tool
// after recording its tool_use, add the symmetric filter here.
function sanitizeNewMessages(msgs: Anthropic.MessageParam[]): ChatMessage[] {
  const resultIds = new Set<string>();
  for (const msg of msgs) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") resultIds.add(block.tool_use_id);
    }
  }

  const sanitized: ChatMessage[] = [];
  for (const msg of msgs) {
    // MessageParam["role"] also allows "system" (mid-conversation system
    // blocks), a feature this app never uses — every message pushed onto
    // `messages` in runChatAgent is "assistant" or "user", so the cast is
    // safe for anything this function is actually called with.
    const role = msg.role as "user" | "assistant";
    if (!Array.isArray(msg.content)) {
      sanitized.push({ role, content: msg.content });
      continue;
    }
    const content = msg.content.filter((block) => block.type !== "tool_use" || resultIds.has(block.id));
    if (content.length === 0) continue;
    sanitized.push({ role, content });
  }
  return sanitized;
}

export type ToolCall = { name: string; input: unknown };

export async function runChatAgent(
  step: Step,
  sessionId: string,
  history: ChatMessage[],
  model: string,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const ch = chatChannel(sessionId);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  // Everything from here on is new — recorded so `newMessages` (published
  // alongside `run.completed`) can hand the client exactly what this run
  // appended, without re-sending history the client already has.
  const historyLength = messages.length;

  let lastText = "";
  const toolCalls: ToolCall[] = [];

  await step.realtime.publish("run-started", ch.status, { type: "run.started" });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await streamTurn(step, ch, turn, messages, model);

      messages.push({ role: "assistant", content: response.content });

      const text = extractText(response.content);
      lastText = text;
      await step.realtime.publish(`turn-completed-${turn}`, ch.status, {
        type: "turn.completed",
        turn,
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          contextWindow: CONTEXT_WINDOW,
        },
      });

      // A max_tokens cutoff can't be treated as a clean finish: the model was
      // cut off mid-turn, not at a natural stopping point, so any tool_use
      // blocks it started emitting may be incomplete (missing input fields,
      // or missing entirely if the cut fell before the block closed). Strip
      // them from the message just pushed above — an unpaired tool_use block
      // makes the replayed history invalid on the next API call — and surface
      // a visible marker so the truncation is never mistaken for a complete
      // answer.
      if (response.stop_reason === "max_tokens") {
        const assistantMessage = messages[messages.length - 1]!;
        if (Array.isArray(assistantMessage.content)) {
          assistantMessage.content = assistantMessage.content.filter((b) => b.type !== "tool_use");
        }
        const marker = "\n\n[Response truncated — output token limit reached.]";
        const finalText = text ? text + marker : marker;
        await step.realtime.publish("run-completed", ch.status, {
          type: "run.completed",
          text: finalText,
          newMessages: sanitizeNewMessages(messages.slice(historyLength)),
        });
        return { text: finalText, toolCalls };
      }

      // Anything other than "tool_use" ends the turn — including stop_reason
      // values this SDK version doesn't know about yet. Treating "unknown" as
      // "done" is the safe default: it surfaces whatever text came back
      // instead of looping forever waiting for a tool call that isn't coming.
      if (response.stop_reason !== "tool_use") {
        await step.realtime.publish("run-completed", ch.status, {
          type: "run.completed",
          text,
          newMessages: sanitizeNewMessages(messages.slice(historyLength)),
        });
        return { text, toolCalls };
      }

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (let i = 0; i < toolUses.length; i++) {
        const block = toolUses[i]!;
        toolCalls.push({ name: block.name, input: block.input });

        await step.realtime.publish(`tool-called-${turn}-${i}`, ch.status, {
          type: "tool.called",
          turn,
          name: block.name,
          input: block.input,
        });

        const output = await step.run(`tool-${block.name}-${turn}-${i}`, () =>
          executeTool(block.name, block.input),
        );

        await step.realtime.publish(`tool-result-${turn}-${i}`, ch.status, {
          type: "tool.result",
          turn,
          name: block.name,
          output,
        });

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Turn cap reached without a natural stop: surface whatever the last
    // turn produced instead of hanging or silently truncating. This path
    // always ends on a user tool_result message (the loop just pushed one at
    // the bottom of the last iteration), which is valid history on its own —
    // consecutive user messages are fine — so it needs no special-casing in
    // sanitizeNewMessages beyond what every other path already gets.
    const fallbackText = lastText || "(turn limit reached without a final response)";
    await step.realtime.publish("run-completed", ch.status, {
      type: "run.completed",
      text: fallbackText,
      newMessages: sanitizeNewMessages(messages.slice(historyLength)),
    });
    return { text: fallbackText, toolCalls };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Client-level, non-durable publish: the function is about to fail and
    // rethrow, so there's nothing left to memoize against — just get the
    // notice out before the run ends. This is best-effort and must never
    // mask the real failure, which is rethrown on the next line regardless.
    await inngest.realtime.publish(ch.status, { type: "run.failed", error }).catch(() => {});
    throw err;
  }
}
