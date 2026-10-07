// The attempt's message history and everything the harness itself says into
// it. Pure functions of a model response, so a replay rebuilds the same
// history from the memoized responses.
import type { ChatResponse } from "./model-call.js";

export type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** The tool calls a response asked for, as the model sent them (these are what run). */
export const toolCalls = (res: ChatResponse): ToolCall[] => (res.choices?.[0]?.message?.tool_calls ?? []) as ToolCall[];

const isJsonObject = (s: string) => {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};

/**
 * The assistant message a response becomes in history. Two repairs, because
 * stricter providers reject the *next* request with a non-retriable 400:
 * - a turn with neither text nor a tool call gets a placeholder (content null
 *   is rejected, and dropping the turn would put two user messages in a row);
 * - tool-call arguments that aren't a JSON object (cut off mid-call) go back
 *   as "{}". The call itself still runs and gets the tool's JSON error.
 */
export function assistantMessage(res: ChatResponse): Msg {
  const msg = res.choices?.[0]?.message;
  const calls = toolCalls(res);
  return {
    role: "assistant",
    content: msg?.content || (calls.length ? null : "(no output)"),
    ...(calls.length
      ? { tool_calls: calls.map((c) => (isJsonObject(c.function.arguments) ? c : { ...c, function: { ...c.function, arguments: "{}" } })) }
      : {}),
  };
}

/** Cut off at the token limit with at least half the output spent reasoning. */
export const cutOffThinking = (res: ChatResponse): boolean => {
  const out = res.usage?.completion_tokens ?? 0;
  const reasoning = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return res.choices?.[0]?.finish_reason === "length" && out > 0 && reasoning >= out / 2;
};

/**
 * What to say after a turn without a tool call. A turn cut off while mostly
 * reasoning needs "stop thinking and act", not "make a smaller edit": its
 * reasoning isn't kept, so the next turn would think from scratch.
 */
export const idleNudge = (res: ChatResponse): string => {
  if (res.choices?.[0]?.finish_reason !== "length") return "Use the tools, then call finish_attempt.";
  const out = res.usage?.completion_tokens ?? 0;
  const reasoning = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (cutOffThinking(res))
    return `You ran out of room for this turn while thinking (${reasoning} of ${out} output tokens were reasoning), so no tool call was made, and that reasoning is not kept. Keep your thinking short and make the tool call right away. If the whole change doesn't fit, make the first part of it with edit_file now.`;
  return "Your output was cut off before you made a tool call. Make a smaller edit with edit_file instead.";
};

export const LAST_TURN_WARNING =
  "This is your last turn. Call finish_attempt now with a one-line summary of what you changed.";

// Small models otherwise "finish" with a plan instead of a change, and the
// attempt is a no-change stall.
export const EMPTY_FINISH_REFUSAL =
  "error: you haven't changed any file in this attempt, so there is nothing to finish. Make the change now with edit_file or write_file, then call finish_attempt.";
