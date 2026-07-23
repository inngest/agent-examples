import type { PageSummary } from "../lib/openrouter";

export type CheckRunOutput = { title: string; summary: string; text: string };

export type ModelResult = {
  variant: string;
  summary: PageSummary | null;
  judgeClarity: number | null;
  heuristics: number | null;
  error?: string; // this model's pipeline failed
};

export type PageResult = {
  path: string;
  route: string;
  models: ModelResult[]; // sample: length 1; compare: one per MODELS entry
  error?: string; // page-level failure (fetch) -> models: []
};

// Marks the sticky PR comment so upsertPRComment can find it across deploys,
// and so the comment can never be mistaken for a `/approve` reply (see the
// instruction text in formatPRComment).
export const COMMENT_MARKER = "<!-- docs-understanding-agent -->";

// GitHub caps label at 20 chars, identifier at 20, description at 40.
export const CHECK_RUN_ACTIONS = [
  { label: "Approve", identifier: "approve", description: "LLM understanding matches intent" },
  { label: "Needs work", identifier: "needs_work", description: "LLM misread these pages" },
];

const PAGE_SECTION_MAX_CHARS = 6_000;
// GitHub caps check-run output.summary and output.text at 65,535 chars each
// (issue comments cap at 65,536). Per-page truncation above keeps individual
// sections small, but the joined text (and the summary table) can still blow
// past the cap once MAX_PAGES is raised, which GitHub rejects with a 422 and
// fails the whole run.
const OUTPUT_MAX_CHARS = 60_000;
const TRUNCATED_SUFFIX = "\n\n_(output truncated)_";

const capOutput = (s: string): string =>
  s.length > OUTPUT_MAX_CHARS ? `${s.slice(0, OUTPUT_MAX_CHARS)}${TRUNCATED_SUFFIX}` : s;

const fmtScore = (v: number | null): string => (v === null ? "–" : v.toFixed(2));

// Only meaningful when at least two models were judged on the same page
// (compare mode) — with one judged model there's nothing to win against.
const pickWinner = (models: ModelResult[]): ModelResult | null => {
  const judged = models.filter((m) => m.judgeClarity !== null);
  if (judged.length < 2) return null;
  return judged.reduce((best, m) => (m.judgeClarity! > best.judgeClarity! ? m : best));
};

// Shared by the check-run output and the PR comment: one row per (page,
// model); a page-level failure collapses to a single "—" row. Repeats the
// route cell on each row (simpler than cell-merging tricks).
const buildSummaryTable = (results: PageResult[]): string => {
  const rows = results.flatMap((r) => {
    if (r.models.length === 0) {
      return [`| \`${r.route}\` | — | – | – |`];
    }
    const winner = pickWinner(r.models);
    return r.models.map((m) => {
      const modelCell = m === winner ? `**${m.variant}** (winner)` : m.variant;
      return `| \`${r.route}\` | ${modelCell} | ${fmtScore(m.judgeClarity)} | ${fmtScore(m.heuristics)} |`;
    });
  });
  return [`| Page | Model | Judge | Heuristics |`, `| --- | --- | --- | --- |`, ...rows].join("\n");
};

const modelBody = (m: ModelResult): string => {
  if (!m.summary) {
    return `⚠️ Analysis failed: ${m.error ?? "unknown error"}\n`;
  }
  const s = m.summary;
  const body = [
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
  return body.length > PAGE_SECTION_MAX_CHARS
    ? `${body.slice(0, PAGE_SECTION_MAX_CHARS)}\n\n_(truncated)_`
    : body;
};

const pageSection = (r: PageResult): string => {
  if (r.models.length === 0) {
    return `### \`${r.route}\`\n\n⚠️ Analysis failed: ${r.error ?? "unknown error"}\n`;
  }
  if (r.models.length === 1) {
    return `### \`${r.route}\` (model: ${r.models[0].variant})\n\n${modelBody(r.models[0])}`;
  }
  const winner = pickWinner(r.models);
  const subsections = r.models.map((m) => {
    const heading = `#### ${m.variant} — judge ${fmtScore(m.judgeClarity)}${m === winner ? " (winner)" : ""}`;
    return `${heading}\n\n${modelBody(m)}`;
  });
  return `### \`${r.route}\`\n\n${subsections.join("\n")}`;
};

export function formatCheckOutput(previewUrl: string, results: PageResult[]): CheckRunOutput {
  const analyzed = results.filter((r) => r.models.some((m) => m.summary));
  const table = buildSummaryTable(results);

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

export function formatPRComment(previewUrl: string, results: PageResult[]): string {
  const table = buildSummaryTable(results);
  // The instruction text below must never *start* a line with the slash
  // command itself — otherwise the bot's own sticky comment could be parsed
  // as a verdict by the issue_comment webhook handler.
  return capOutput(
    `${COMMENT_MARKER}\n` +
      `### LLM understanding of this PR's docs changes\n\n` +
      `Preview: ${previewUrl}\n\n${table}\n\n` +
      `Reply **\`/approve\`** if these understandings match your intent, or **\`/needs-work\`** if the model misread the pages.`,
  );
}
