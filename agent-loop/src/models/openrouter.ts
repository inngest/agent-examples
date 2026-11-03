// The coder's model: any OpenRouter model, through its OpenAI-compatible API.
// The loop hands over its history and tools each turn; this maps them to a
// chat request, pins providers that honour every parameter, and climbs the
// reasoning ladder inside the call, so the loop never sees a turn that was
// cut off before it acted.
import OpenAI from "openai";
import type { AgentModel, AgentModelRequest, AgentModelResponse, ModelMessage } from "inngest/experimental/agents";

export type ModelSettings = {
  slug: string;
  // Output budget of a turn, and the most the ladder may grow it to.
  maxTokensPerTurn: number;
  maxTokensCap: number;
  // From the model profile: whether `reasoning` may be sent at all.
  supportsReasoning: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningMaxTokens?: number;
  // Where earlier attempts' ladders settled; this attempt starts there.
  startRung?: number;
};

type Reasoning = { effort: "low" | "medium" | "high" } | { max_tokens: number } | { enabled: false };

/** One rung of the ladder: what a call sends. */
export type Rung = { maxTokens: number; reasoning?: Reasoning };
type Nudge = "thinking" | "whitespace" | "cutoff";

/**
 * The ladder for these settings. A turn cut off before its tool call is tried
 * again one rung up: first with a nudge, then with double the budget, then
 * with reasoning off. Only what the profile allows is sent.
 */
export function ladder(s: ModelSettings): Rung[] {
  const configured = (maxTokens: number): Reasoning | undefined => {
    if (!s.supportsReasoning) return undefined;
    // OpenRouter takes one or the other. The budget wins, clamped to half the
    // turn so reasoning can't leave no room for the tool call.
    if (s.reasoningMaxTokens) return { max_tokens: Math.min(s.reasoningMaxTokens, Math.floor(maxTokens / 2)) };
    return s.reasoningEffort ? { effort: s.reasoningEffort } : undefined;
  };
  const base = s.maxTokensPerTurn;
  const raised = Math.min(s.maxTokensCap, base * 2);
  const rungs: Rung[] = [
    { maxTokens: base, reasoning: configured(base) },
    // The same again: the first retry only gets the nudge.
    { maxTokens: base, reasoning: configured(base) },
  ];
  if (raised > base) rungs.push({ maxTokens: raised, reasoning: configured(raised) });
  if (s.supportsReasoning) rungs.push({ maxTokens: raised, reasoning: { enabled: false } });
  return rungs;
}

type Chat = OpenAI.Chat.Completions.ChatCompletion & {
  provider?: string;
  usage?: OpenAI.CompletionUsage & { cost?: number };
};
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// What the loop keeps in its history for a reply: the chat message to send
// back, and the rung it was made on, so the coder can read the ladder from the
// history on replay.
type Stored = { chat: ChatMessage; rung: number };

/** Cut off at the token limit before making a tool call. */
const cutOff = (res: Chat) => res.choices[0]?.finish_reason === "length" && !res.choices[0]?.message.tool_calls?.length;

// Mostly blank: a stuck model pads an opened tool call with whitespace until the budget runs out.
const blank = (s: string | null | undefined) => !!s && s.length >= 500 && s.replace(/\s/g, "").length < s.length * 0.05;
const whitespaceRunaway = (res: Chat) => {
  const m = res.choices[0]?.message as { content?: string | null; reasoning?: string | null } | undefined;
  return cutOff(res) && (blank(m?.content) || blank(m?.reasoning));
};

// Cut off with at least half the output spent reasoning.
const thinking = (res: Chat) => {
  const out = res.usage?.completion_tokens ?? 0;
  return out > 0 && (res.usage?.completion_tokens_details?.reasoning_tokens ?? 0) >= out / 2;
};

const NUDGES: Record<Nudge, string> = {
  thinking:
    "You ran out of room for your last turn while thinking, so no tool call was made, and that reasoning is not kept. Keep your thinking short and make the tool call right away. If the whole change doesn't fit, make the first part of it with work_edit now.",
  whitespace:
    "Your last turn used all its output tokens on whitespace and made no tool call. Don't write a tool call, JSON or code as text, and don't pad with spaces or newlines. Make one tool call now: a small work_edit on the function you are fixing.",
  cutoff: "Your output was cut off before you made a tool call. Make a smaller edit with work_edit instead.",
};

// The loop's history as chat messages.
function toChat(request: AgentModelRequest): ChatMessage[] {
  const out: ChatMessage[] = request.system ? [{ role: "system", content: request.system }] : [];
  for (const m of request.messages as ModelMessage[]) {
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("\n");
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      out.push((m.content as Stored).chat);
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
    }
  }
  return out;
}

const isJsonObject = (s: string) => {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};

// Stricter providers reject the next request if the history has a reply with
// no content and no tool call, or tool-call arguments that aren't a JSON
// object (cut off mid-call), so both are repaired before they're kept.
function keep(res: Chat): ChatMessage {
  const m = res.choices[0]!.message;
  const calls = m.tool_calls ?? [];
  return {
    role: "assistant",
    content: m.content?.trim() || (calls.length ? null : "(no output)"),
    ...(calls.length
      ? {
          tool_calls: calls.map((c) =>
            c.type === "function" && !isJsonObject(c.function.arguments) ? { ...c, function: { ...c.function, arguments: "{}" } } : c,
          ),
        }
      : {}),
  };
}

export const openrouter = (s: ModelSettings): AgentModel => {
  const client = new OpenAI({
    baseURL: process.env.MODEL_BASE_URL ?? "https://openrouter.ai/api/v1/",
    apiKey: process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "",
    maxRetries: 0, // the model step retries
  });
  // MODEL_PROVIDERS pins a preference order (the same model differs by
  // provider), with no fallback to one we pinned away from. Without it, the
  // fastest provider that honours every parameter.
  const preferred = (process.env.MODEL_PROVIDERS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const provider = {
    require_parameters: true,
    ...(preferred.length ? { order: preferred, allow_fallbacks: false } : { sort: "throughput" }),
  };
  const rungs = ladder(s);

  const call = async (request: AgentModelRequest, rung: Rung, nudge?: Nudge): Promise<Chat> => {
    const messages = toChat(request);
    if (nudge) messages.push({ role: "user", content: NUDGES[nudge] });
    const res = (await client.chat.completions.create(
      {
        model: s.slug,
        messages,
        tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice:
          typeof request.toolChoice === "object"
            ? { type: "function", function: { name: request.toolChoice.tool } }
            : (request.toolChoice ?? "auto"),
        max_tokens: rung.maxTokens,
        ...(rung.reasoning ? { reasoning: rung.reasoning } : {}),
        provider,
      } as never,
      // A slow provider needs about 3 minutes for 16k tokens.
      { timeout: Math.max(Number(process.env.MODEL_TIMEOUT_MS) || 180_000, rung.maxTokens * 15) },
    )) as Chat;
    // OpenRouter can answer 200 with an error body (an upstream failure): retried.
    if (!res.choices?.length) throw new Error(`model call failed upstream: ${JSON.stringify((res as { error?: unknown }).error ?? "no choices")}`);
    return res;
  };

  return async (request): Promise<AgentModelResponse> => {
    let r = Math.min(s.startRung ?? 0, rungs.length - 1);
    const usage = { input: 0, output: 0, usd: 0 };
    let nudge: Nudge | undefined;
    let res: Chat;
    for (;;) {
      res = await call(request, rungs[r]!, nudge);
      usage.input += res.usage?.prompt_tokens ?? 0;
      usage.output += res.usage?.completion_tokens ?? 0;
      usage.usd += res.usage?.cost ?? 0;
      if (!cutOff(res) || r === rungs.length - 1) break;
      // Reasoning that is only whitespace won't use a bigger budget any better.
      nudge = whitespaceRunaway(res) ? "whitespace" : thinking(res) ? "thinking" : "cutoff";
      r = nudge === "whitespace" ? rungs.length - 1 : r + 1;
    }

    const m = res.choices[0]!.message;
    return {
      message: { role: "assistant", content: { chat: keep(res), rung: r } satisfies Stored },
      text: m.content ?? "",
      toolCalls: (m.tool_calls ?? []).flatMap((c) =>
        c.type === "function" ? [{ id: c.id, name: c.function.name, input: isJsonObject(c.function.arguments) ? JSON.parse(c.function.arguments) : {} }] : [],
      ),
      usage,
      usd: usage.usd,
      model: s.slug,
      // For onTurn (the TUI's turn line): what the reply itself says.
      details: {
        finishReason: res.choices[0]!.finish_reason,
        provider: res.provider ?? null,
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        maxTokens: rungs[r]!.maxTokens,
        reasoningOff: rungs[r]!.reasoning !== undefined && "enabled" in rungs[r]!.reasoning!,
        blank: whitespaceRunaway(res),
        rung: r,
      },
    };
  };
};

/** The highest rung any acting reply in this history was made on: where the next attempt starts. */
export function settledRung(history: ModelMessage[]): number | undefined {
  const acted = history.flatMap((m) =>
    m.role === "assistant" && (m.content as Stored).chat.role === "assistant" && "tool_calls" in (m.content as Stored).chat ? [(m.content as Stored).rung] : [],
  );
  const top = Math.max(0, ...acted);
  return top > 0 ? top : undefined;
}
