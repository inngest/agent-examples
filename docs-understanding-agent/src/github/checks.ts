import type { PageSummary } from "../lib/openrouter";

export type CheckRunOutput = { title: string; summary: string; text: string };

export type PageResult = {
  path: string;
  route: string;
  variant: string;
  summary: PageSummary | null;
  judgeClarity: number | null;
  heuristics: number | null;
  error?: string;
};

// GitHub caps label at 20 chars, identifier at 20, description at 40.
export const CHECK_RUN_ACTIONS = [
  { label: "Approve", identifier: "approve", description: "LLM understanding matches intent" },
  { label: "Needs work", identifier: "needs_work", description: "LLM misread these pages" },
];

const PAGE_SECTION_MAX_CHARS = 6_000;
// GitHub caps check-run output.summary and output.text at 65,535 chars each.
// Per-page truncation above keeps individual sections small, but the joined
// text (and the summary table) can still blow past the cap once MAX_PAGES is
// raised, which GitHub rejects with a 422 and fails the whole run.
const OUTPUT_MAX_CHARS = 60_000;
const TRUNCATED_SUFFIX = "\n\n_(output truncated)_";

const capOutput = (s: string): string =>
  s.length > OUTPUT_MAX_CHARS ? `${s.slice(0, OUTPUT_MAX_CHARS)}${TRUNCATED_SUFFIX}` : s;

const fmtScore = (v: number | null): string => (v === null ? "–" : v.toFixed(2));

const pageSection = (r: PageResult): string => {
  if (!r.summary) {
    return `### \`${r.route}\`\n\n⚠️ Analysis failed: ${r.error ?? "unknown error"}\n`;
  }
  const s = r.summary;
  const section = [
    `### \`${r.route}\` (model: ${r.variant})`,
    ``,
    `**What this page is about:** ${s.pageTopic}`,
    ``,
    `**Key concepts:**`,
    ...s.keyConcepts.map((c) => `- ${c}`),
    ``,
    `**Intended audience:** ${s.intendedAudience}`,
    ``,
    s.ambiguities.length
      ? `**Ambiguities the model flagged:**\n${s.ambiguities.map((a) => `- ${a}`).join("\n")}`
      : `**Ambiguities the model flagged:** none`,
    ``,
  ].join("\n");
  return section.length > PAGE_SECTION_MAX_CHARS
    ? `${section.slice(0, PAGE_SECTION_MAX_CHARS)}\n\n_(truncated)_`
    : section;
};

export function formatCheckOutput(previewUrl: string, results: PageResult[]): CheckRunOutput {
  const analyzed = results.filter((r) => r.summary);
  const table = [
    `| Page | Model | Judge | Heuristics |`,
    `| --- | --- | --- | --- |`,
    ...results.map(
      (r) =>
        `| \`${r.route}\` | ${r.summary ? r.variant : "—"} | ${fmtScore(r.judgeClarity)} | ${fmtScore(r.heuristics)} |`,
    ),
  ].join("\n");

  return {
    title: `LLM understanding: ${analyzed.length}/${results.length} page(s) analyzed`,
    summary: capOutput(
      `LLM agents read each changed page on the [preview deploy](${previewUrl}) and summarized ` +
        `what they understood. Scores: judge = LLM-graded clarity (0–1), heuristics = shape checks.\n\n${table}\n\n` +
        `Use the **Approve** / **Needs work** buttons to record whether these understandings match your intent.`,
    ),
    text: capOutput(results.map(pageSection).join("\n---\n\n")),
  };
}
