// The reasoning ladder: how an attempt makes sure a thinking model gets to act.
// A turn cut off while mostly reasoning gets, in order: only the nudge
// (idleNudge); then a doubled turn budget (once, up to the cap); then reasoning
// off. Reasoning caps can't be trusted, but off works whatever control a model
// has (see BUILD_LOG: reasoning ladder). Pure: it changes only in observe(),
// from memoized responses, so a replay climbs it identically.
import { cutOffThinking } from "./history.js";
import type { ChatResponse } from "./model-call.js";

/** Most the ladder grows a turn's budget to when the model profile states no limit. */
export const MAX_TOKENS_CAP = 32_000;

// OpenRouter's way of turning reasoning off; honoured where budgets and low
// efforts weren't.
const REASONING_OFF = { enabled: false } as const;

export type ReasoningEffort = "low" | "medium" | "high";
export type Reasoning = { effort: ReasoningEffort } | { max_tokens: number } | typeof REASONING_OFF;
/** Where earlier attempts' ladders ended up; a new attempt starts there. */
export type LadderStart = { maxTokens?: number; reasoningOff?: boolean };
export type Learned = { maxTokens: number; reasoningOff: boolean };

export type LadderOptions = {
  // Configured controls, both opt-in. With neither, no `reasoning` is sent.
  effort?: ReasoningEffort;
  reasoningMaxTokens?: number;
  maxTokensPerTurn: number;
  maxTokensCap: number;
  // From the model profile: whether `reasoning` may be sent at all.
  supportsReasoning: boolean;
  start?: LadderStart;
};

/** What to send this turn. */
export type Turn = { maxTokens: number; reasoning?: Reasoning; reasoningOff: boolean; timeoutMs: number };

export class ReasoningLadder {
  private budget: number;
  private reasoningOff: boolean;
  private thinkingCutoffs = 0;
  private raised = false;
  private escalated = false;
  private escalationWorked = false;

  constructor(private readonly o: LadderOptions) {
    this.budget = Math.min(o.maxTokensCap, Math.max(o.maxTokensPerTurn, o.start?.maxTokens ?? 0));
    this.reasoningOff = o.supportsReasoning && o.start?.reasoningOff === true;
  }

  turn(): Turn {
    return {
      maxTokens: this.budget,
      reasoning: !this.o.supportsReasoning ? undefined : this.reasoningOff ? REASONING_OFF : this.configured(),
      reasoningOff: this.reasoningOff,
      // A slow provider (~100 tok/s) needs ~3 minutes for 16k tokens; never
      // below MODEL_TIMEOUT_MS (default 180s).
      timeoutMs: Math.max(Number(process.env.MODEL_TIMEOUT_MS) || 180_000, this.budget * 15),
    };
  }

  // OpenRouter treats reasoning.effort and reasoning.max_tokens as mutually
  // exclusive. Prefer the token budget (effort is not reliably honoured), and
  // clamp it to half the turn so reasoning can't leave no room for the tool call.
  private configured(): Reasoning | undefined {
    const { reasoningMaxTokens, effort } = this.o;
    if (reasoningMaxTokens !== undefined) return { max_tokens: Math.min(reasoningMaxTokens, Math.floor(this.budget / 2)) };
    return effort !== undefined ? { effort } : undefined;
  }

  /** After each turn. Returns a log line when the ladder climbed a rung. */
  observe(res: ChatResponse): string | undefined {
    const acted = (res.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0;
    if (acted) {
      if (this.escalated) this.escalationWorked = true;
      return undefined;
    }
    if (!cutOffThinking(res)) return undefined;
    this.thinkingCutoffs++;
    // The first one only gets the nudge; after that, one rung per cut-off.
    if (this.thinkingCutoffs < 2) return undefined;
    if (!this.raised && this.budget < this.o.maxTokensCap) {
      this.raised = this.escalated = true;
      this.budget = Math.min(this.o.maxTokensCap, this.budget * 2);
      return `cut off while reasoning again: turn budget → ${this.budget}`;
    }
    if (this.o.supportsReasoning && !this.reasoningOff) {
      this.reasoningOff = this.escalated = true;
      return "cut off while reasoning again: reasoning off for the rest of the attempt";
    }
    return undefined;
  }

  /** Where the ladder settled, only if it had to climb and the model then acted. */
  learned(): Learned | undefined {
    return this.escalationWorked ? { maxTokens: this.budget, reasoningOff: this.reasoningOff } : undefined;
  }
}
