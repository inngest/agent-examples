import Anthropic from "@anthropic-ai/sdk";
import type { GetStepTools } from "inngest";
import { toolDefinitions, executeTool } from "./tools";
import { inngest } from "../inngest/client";
import { chatChannel, type ChatMessage } from "../inngest/channel";

// The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the
// environment itself, so no manual client configuration is needed here.
const client = new Anthropic();

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

// Tuned for Claude (Haiku through Opus): explicit trigger conditions per tool
// (recent Claude models reach for tools conservatively unless told when),
// parallel calls encouraged, and output style matched to the UI, which
// renders plain text — markdown would show up as literal asterisks.
const SYSTEM_PROMPT = `You are a friendly assistant in a live chat UI.

When a question involves current weather, arithmetic, or the current date or time — including follow-up questions later in the conversation — call the matching tool (get_weather, calculate, get_current_time) and answer from its result. When one message asks about several independent things, call the tools in parallel in a single turn. Answer everything else directly from your own knowledge.

Keep replies short and conversational: a sentence or two, more only when the question genuinely needs it. The chat renders plain text, so write prose without markdown formatting, headings, or tables.`;

// Batch window for streamed token deltas: each publish is one HTTP POST, so
// this trades a little latency for far fewer round trips than publishing
// per-character.
const BATCH_MS = 40;

// Belt-and-suspenders against a runaway tool-use loop (e.g. a model that
// never stops calling tools) — bounds both cost and worst-case run time.
const MAX_TURNS = 8;

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
): Promise<Anthropic.Message> {
  const result = await step.run(`llm-turn-${turn}`, async () => {
    let seq = 0;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (!buffer) return;
      const delta = buffer;
      buffer = "";
      timer = null;
      // Fire-and-forget, non-durable: this is a live UI nicety, not part of
      // the durable record. `turn.completed` (below, durable) is the
      // authoritative text the UI falls back to if any deltas are lost. The
      // rejection is swallowed because a dropped batch is recoverable, but
      // an unhandled rejection is fatal under Node's default settings.
      void inngest.realtime.publish(ch.tokens, { turn, seq: seq++, delta }).catch(() => {});
    };

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
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
    }
  });

  // step.run JSON-round-trips the result, but it's really this shape.
  return result as unknown as Anthropic.Message;
}

export async function runChatAgent(step: Step, sessionId: string, history: ChatMessage[]): Promise<string> {
  const ch = chatChannel(sessionId);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

  let lastText = "";

  await step.realtime.publish("run-started", ch.status, { type: "run.started" });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await streamTurn(step, ch, turn, messages);

      messages.push({ role: "assistant", content: response.content });

      const text = extractText(response.content);
      lastText = text;
      await step.realtime.publish(`turn-completed-${turn}`, ch.status, {
        type: "turn.completed",
        turn,
        text,
      });

      // Anything other than "tool_use" ends the turn — including stop_reason
      // values this SDK version doesn't know about yet. Treating "unknown" as
      // "done" is the safe default: it surfaces whatever text came back
      // instead of looping forever waiting for a tool call that isn't coming.
      if (response.stop_reason !== "tool_use") {
        await step.realtime.publish("run-completed", ch.status, { type: "run.completed", text });
        return text;
      }

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (let i = 0; i < toolUses.length; i++) {
        const block = toolUses[i]!;

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
    // turn produced instead of hanging or silently truncating.
    const fallbackText = lastText || "(turn limit reached without a final response)";
    await step.realtime.publish("run-completed", ch.status, { type: "run.completed", text: fallbackText });
    return fallbackText;
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
