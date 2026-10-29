// The "Start a goal" form: every goal option on one screen, instead of flags.
// ↑↓ picks a row, ←→ (or Space) changes its value, typing edits the goal id,
// Enter starts, Esc closes. Flags given on the command line become the form's
// starting values, so `--spec` etc. still work as presets.
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { GOAL_DEFAULTS, VARIANT_NAMES } from "../../src/inngest/events.js";
import type { GoalOptions } from "../../src/lib/start-goal.js";
import { c } from "./format.js";

type Choice<T> = { label: string; value: T };
type Row =
  | { kind: "text"; key: "goalId"; label: string; value: string; help: string }
  | { kind: "choice"; key: string; label: string; choices: Choice<Partial<GoalOptions>>[]; index: number; help: string };

// Models offered in the form; a --model on the command line is added to these.
const MODELS = ["nvidia/nemotron-3.5-lightning", "qwen/qwen3.8-27b", "mistralai/mistral-large-4-0"];

const numbers = (key: keyof GoalOptions, values: number[], unit = "") =>
  values.map((v) => ({ label: `${v}${unit}`, value: { [key]: v } as Partial<GoalOptions> }));

// The choice matching the preset, adding it if it isn't one of the listed values.
function choiceRow(key: string, label: string, help: string, choices: Choice<Partial<GoalOptions>>[], current: Choice<Partial<GoalOptions>>): Row {
  const same = (a: Partial<GoalOptions>, b: Partial<GoalOptions>) => JSON.stringify(a) === JSON.stringify(b);
  let index = choices.findIndex((ch) => same(ch.value, current.value));
  if (index < 0) {
    choices = [current, ...choices];
    index = 0;
  }
  return { kind: "choice", key, label, choices, index, help };
}

export class StartForm implements Component {
  private rows: Row[];
  private selected = 0;
  error = "";

  constructor(
    preset: Partial<GoalOptions>,
    private readonly opts: { target: string; resetsWorkspace: boolean; onStart: (o: GoalOptions) => void; onCancel: () => void },
  ) {
    const p = preset;
    const reasoning: Choice<Partial<GoalOptions>>[] = [
      { label: "worker default", value: {} },
      ...(["low", "medium", "high"] as const).map((e) => ({ label: `effort ${e}`, value: { reasoningEffort: e } })),
      ...[2000, 5000, 8000, 16000].map((n) => ({ label: `budget ${n} tok`, value: { reasoningMaxTokens: n } })),
    ];
    this.rows = [
      { kind: "text", key: "goalId", label: "Goal id", value: p.goalId ?? "", help: "Type to edit, Ctrl+U to clear. A new id starts a new goal; an existing one restarts it." },
      choiceRow("model", "Model", "Any OpenRouter slug works with --model; it's added here.", [{ label: "worker default", value: {} }, ...MODELS.map((m) => ({ label: m, value: { model: m } }))], {
        label: p.model ?? "worker default",
        value: p.model ? { model: p.model } : {},
      }),
      choiceRow("maxAttempts", "Attempts", "The most attempts the goal runs.", numbers("maxAttempts", [10, 20, 40, 60]), {
        label: `${p.maxAttempts ?? GOAL_DEFAULTS.maxAttempts}`,
        value: { maxAttempts: p.maxAttempts ?? GOAL_DEFAULTS.maxAttempts },
      }),
      choiceRow("maxStalls", "Stalls before review", "Attempts in a row without progress before it pauses for you.", numbers("maxStalls", [2, 3, 4, 5, 8]), {
        label: `${p.maxStalls ?? GOAL_DEFAULTS.maxStalls}`,
        value: { maxStalls: p.maxStalls ?? GOAL_DEFAULTS.maxStalls },
      }),
      choiceRow("maxTokensPerTurn", "Tokens per turn", "Output budget per model turn, reasoning included.", numbers("maxTokensPerTurn", [4000, 8000, 12000, 20000, 32000]), {
        label: `${p.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn}`,
        value: { maxTokensPerTurn: p.maxTokensPerTurn ?? GOAL_DEFAULTS.maxTokensPerTurn },
      }),
      choiceRow(
        "reasoning",
        "Reasoning",
        "A budget is capped at half the turn's tokens so the tool call keeps room (16000 needs 32000 per turn). Worker default: REASONING_* env, or none.",
        reasoning,
        p.reasoningMaxTokens
          ? { label: `budget ${p.reasoningMaxTokens} tok`, value: { reasoningMaxTokens: p.reasoningMaxTokens } }
          : p.reasoningEffort
            ? { label: `effort ${p.reasoningEffort}`, value: { reasoningEffort: p.reasoningEffort } }
            : reasoning[0]!,
      ),
      choiceRow("focus", "Focus", "Each attempt works on one failing function.", [
        { label: "on", value: {} },
        { label: "off", value: { focus: false } },
      ], p.focus === false ? { label: "off", value: { focus: false } } : { label: "on", value: {} }),
      choiceRow("spec", "Go docs in brief", "Include Go's documentation for the package (data/spec.txt).", [
        { label: "off", value: {} },
        { label: "on", value: { spec: true } },
      ], p.spec ? { label: "on", value: { spec: true } } : { label: "off", value: {} }),
      choiceRow("examples", "Examples per brief", "With a focus, drawn from that function's own failing cases.", [
        { label: "10 (default)", value: {} },
        ...numbers("examplesPerBrief", [20, 40, 50]),
      ], p.examplesPerBrief ? { label: `${p.examplesPerBrief}`, value: { examplesPerBrief: p.examplesPerBrief } } : { label: "10 (default)", value: {} }),
      choiceRow("variant", "Brief experiment", "Runs the \"brief\" experiment with this variant; its options override the three rows above.", [
        { label: "off", value: {} },
        ...VARIANT_NAMES.map((v) => ({ label: v, value: { variant: v } })),
      ], p.variant ? { label: p.variant, value: { variant: p.variant } } : { label: "off", value: {} }),
    ];
  }

  /** The options the form currently describes. */
  options(): GoalOptions {
    let o: Partial<GoalOptions> = {};
    for (const r of this.rows) o = r.kind === "text" ? { ...o, goalId: r.value.trim() } : { ...o, ...r.choices[r.index]!.value };
    return o as GoalOptions;
  }

  handleInput(data: string) {
    const row = this.rows[this.selected]!;
    const step = (d: number) => {
      if (row.kind === "choice") row.index = (row.index + d + row.choices.length) % row.choices.length;
    };
    if (matchesKey(data, "up")) this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = (this.selected + 1) % this.rows.length;
    else if (matchesKey(data, "left")) step(-1);
    else if (matchesKey(data, "right") || (data === " " && row.kind === "choice")) step(1);
    else if (matchesKey(data, "escape")) this.opts.onCancel();
    else if (matchesKey(data, "enter")) {
      const o = this.options();
      if (!o.goalId) {
        this.error = "Give the goal an id first.";
        this.selected = 0;
      } else this.opts.onStart(o);
    } else if (row.kind === "text") {
      if (matchesKey(data, "backspace")) row.value = row.value.slice(0, -1);
      else if (matchesKey(data, "ctrl+u")) row.value = "";
      // Goal ids travel in event data and channel names: keep them simple.
      else if (/^[\w.-]+$/.test(data)) row.value += data;
    }
  }

  invalidate() {}

  // Drawn in a box so the dashboard underneath doesn't show through.
  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    const box = (s: string) => {
      const t = truncateToWidth(s, inner);
      return `${c.magenta("│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${c.magenta("│")}`;
    };
    const bar = (l: string, r: string) => c.magenta(l + "─".repeat(inner + 2) + r);
    return [bar("╭", "╮"), ...this.lines().map(box), bar("╰", "╯")];
  }

  private lines(): string[] {
    const fit = (s: string) => s;
    const labelWidth = Math.max(...this.rows.map((r) => r.label.length)) + 2;
    const out = [fit(`${c.bold("Start a goal")}  ${c.dim(`on ${this.opts.target}`)}`), ""];
    this.rows.forEach((r, k) => {
      const on = k === this.selected;
      const value =
        r.kind === "text"
          ? `${r.value}${on ? "▏" : ""}` || c.dim("(type an id)")
          : on
            ? `‹ ${c.cyan(r.choices[r.index]!.label)} ›`
            : r.choices[r.index]!.label;
      out.push(fit(`${on ? c.magenta("▸") : " "} ${(on ? c.bold : (s: string) => s)(r.label.padEnd(labelWidth))}${value}`));
    });
    out.push("", fit(c.dim(`  ${this.rows[this.selected]!.help}`)));
    if (this.opts.resetsWorkspace) out.push(fit(c.yellow("  Starting resets the local workspace to the stubs.")));
    if (this.error) out.push(fit(c.red(`  ${this.error}`)));
    out.push("", fit(c.dim("  ↑↓ move · ←→ change · Enter start · Esc cancel")));
    return out;
  }
}
