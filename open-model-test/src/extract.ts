// Deterministic code extraction from a model reply. Both models get the same
// prompt contract and both go through these exact functions — no
// model-specific leniency anywhere in the pipeline.
//
// Two formats, in priority order (spec v2 §7 agentic loop):
//
// 1. Multi-file markers — the contract for agentic turns:
//
//        --- pkg/foo.go ---
//        <complete file contents>
//        --- pkg/bar.go ---
//        <complete file contents>
//
//    Sections end at the next marker, a generic `--- end ---`, or EOF.
//    Models sometimes wrap the whole payload in one fenced block; markers
//    inside a single fence are unwrapped before parsing.
//
// 2. Single fenced block — the single-shot coding contract (unchanged since
//    M1, so validated tasks keep their behavior): complete blocks are joined;
//    a lone unterminated fence (truncated reply) keeps everything after the
//    fence line so a max_tokens cutoff doesn't score as garbage; no fences
//    means the trimmed raw text.

const FENCE_RE = /```[^\n]*\n[\s\S]*?(?:```|$)/g;
const MARKER_RE = /^---\s+(.+?)\s+---\s*$/;
const END_RE = /^---\s+end\s*---\s*$/;

function stripFenceDelimiters(block: string): string {
  return block.replace(/^```[^\n]*\n?/, "").replace(/\n?```[ \t]*$/, "");
}

export function extractCode(text: string): { code: string; extracted: boolean } {
  const blocks = text.match(FENCE_RE) ?? [];
  if (blocks.length > 0) {
    return { code: blocks.map(stripFenceDelimiters).join("\n\n").trim(), extracted: true };
  }
  return { code: text.trim(), extracted: false };
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")
  );
}

function normalizeContent(content: string): string {
  // Same EOF-newline normalization the sandbox runners apply to entrypoints:
  // a serialization quirk, not a code-quality signal.
  return content.replace(/\n*$/, "\n");
}

// Strips a single outer fence when the model wrapped its whole marker
// payload (detectable: exactly one fenced block containing >=1 marker).
function unwrapFencedMarkers(text: string): string {
  const blocks = text.match(FENCE_RE) ?? [];
  if (blocks.length === 1) {
    const inner = stripFenceDelimiters(blocks[0]);
    if (MARKER_RE.test(inner.split("\n").find((l) => l.trim() !== "") ?? "")) return inner;
  }
  return text;
}

export type ExtractedFiles = {
  files: Record<string, string>;
  extracted: boolean;
  parseError: string | null;
};

// Multi-file extraction for agentic turns. Falls back to the single-block
// contract mapped onto `entrypoint` (empty entrypoint + no markers =
// unparseable — the loop feeds the error back to the model as a failed turn).
export function extractFiles(text: string, entrypoint: string): ExtractedFiles {
  const payload = unwrapFencedMarkers(text);
  const lines = payload.split("\n");

  const files: Record<string, string> = {};
  let current: string | null = null;
  const contents: string[] = [];

  const flush = () => {
    if (current !== null) {
      let content = contents.join("\n").replace(/^\n+/, "");
      // Models fence each file's contents inside the marker section despite
      // the contract; strip a full-body fence (never inner ones — those are
      // code under test).
      const trimmed = content.trim();
      if (trimmed.startsWith("```") && trimmed.endsWith("```") && trimmed.length > 6) {
        content = trimmed.replace(/^```[^\n]*\n?/, "").replace(/\n?```[ \t]*$/, "");
      }
      if (safeRelativePath(current)) files[current] = normalizeContent(content);
    }
    contents.length = 0;
  };

  for (const line of lines) {
    const end = END_RE.test(line);
    const marker = MARKER_RE.exec(line);
    if (marker && !end) {
      flush();
      current = marker[1].trim();
    } else if (end) {
      flush();
      current = null;
    } else if (current !== null) {
      contents.push(line);
    }
  }
  flush();

  const paths = Object.keys(files);
  if (paths.length > 0) {
    return { files, extracted: true, parseError: null };
  }

  // Fallback: single-block coding contract onto the entrypoint.
  const { code, extracted } = extractCode(text);
  if (extracted && entrypoint) {
    return { files: { [entrypoint]: normalizeContent(code) }, extracted: true, parseError: null };
  }
  if (!extracted && entrypoint && code) {
    return { files: { [entrypoint]: normalizeContent(code) }, extracted: false, parseError: null };
  }
  return {
    files: {},
    extracted: false,
    parseError:
      `no parseable files in reply (expected --- <path> --- markers` +
      (entrypoint ? " or a single fenced code block" : "") +
      ")",
  };
}
