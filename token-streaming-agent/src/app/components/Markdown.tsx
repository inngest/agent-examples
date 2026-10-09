import { createElement, memo, type ReactNode } from "react";

// Minimal, dependency-free Markdown renderer for assistant chat bubbles.
//
// The model streams Markdown (headings, lists, code, emphasis, links); this
// turns the common subset into React nodes. It builds real elements rather than
// setting innerHTML, so raw HTML in the model's output is rendered as literal
// text, never injected — the renderer is XSS-safe by construction, and link
// hrefs are still scheme-checked (sanitizeHref) as defense in depth.
//
// Scope is deliberately the LLM-common subset — headings, fenced/inline code,
// unordered/ordered lists, blockquotes, horizontal rules, bold/italic, links.
// Underscore emphasis (_x_ / __x__) is intentionally *not* treated as emphasis
// so snake_case tool names like get_weather_multi survive intact; use asterisks
// for bold/italic. Unclosed spans/fences degrade gracefully, which matters
// while a reply is still streaming token-by-token.

// Hard ceiling on how much text is ever parsed/rendered in one bubble. The live
// bubble re-runs this renderer on the *entire* accumulated turn on every ~40ms
// token batch, so a model that runs away and streams a huge (or pathologically
// backtracking) output would re-parse an ever-growing string every frame and
// OOM the tab. Capping the input bounds each render to a fixed cost. Generous
// enough that any normal reply is untouched; the full text is still kept in the
// transcript/history — only the on-screen render is clipped.
const MAX_RENDER_CHARS = 20_000;

// Memoized: the parent Chat re-renders on every ~40ms token batch during
// streaming, and a settled assistant turn's text never changes while another
// turn streams. Without memo, every settled bubble re-parses its full Markdown
// (parseSpans creates a React element per span) ~25×/sec — on a long,
// formatting-heavy reply (e.g. monty analysis output) that allocation storm
// OOMs the tab. `text` is the only prop, so a shallow compare skips re-parse.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const capped =
    text.length > MAX_RENDER_CHARS
      ? text.slice(0, MAX_RENDER_CHARS) + "\n\n… (output truncated)"
      : text;
  return <div className="md">{renderBlocks(capped)}</div>;
});

// A line begins a non-paragraph block — used so paragraph gathering stops at the
// next structural element instead of swallowing it.
function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — block separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block. Collect verbatim until the closing fence (or EOF, so a
    // still-streaming, not-yet-closed block renders as code rather than markup).
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or step past EOF)
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading (# … ######).
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      blocks.push(
        createElement(
          `h${level}`,
          { key: key++, className: "md-h" },
          ...parseInline(heading[2], `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // Blockquote — gather the run of `>` lines and render their inner Markdown.
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(quote.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      const k = key++;
      blocks.push(
        <ul key={k} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{parseInline(it, `ul${k}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list — preserve the first item's number as the `start`.
    if (/^\s*\d+\.\s+/.test(line)) {
      const start = Number(line.match(/^\s*(\d+)\./)?.[1] ?? 1);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      const k = key++;
      blocks.push(
        <ol key={k} className="md-ol" start={start}>
          {items.map((it, j) => (
            <li key={j}>{parseInline(it, `ol${k}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive text lines until a blank line or the start
    // of another block; single newlines inside become soft <br/> breaks.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {parseInline(para.join("\n"), `p${key}`)}
      </p>,
    );
  }

  return blocks;
}

// Inline: split on newlines (soft breaks) and parse spans within each line.
function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((seg, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br${idx}`} />);
    out.push(...parseSpans(seg, `${keyPrefix}-s${idx}`));
  });
  return out;
}

// Earliest-match order per position: inline code, then bold (**), then italic
// (*), then links. Code is literal; the others recurse for nesting.
const INLINE_RE =
  /(`+)([\s\S]+?)\1|(\*\*)([\s\S]+?)\*\*|(\*)([\s\S]+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

// Cap on a single line's inline parsing. INLINE_RE's backreference + lazy spans
// can backtrack super-linearly, and this runs on every streamed frame — a very
// long line (a pasted blob, minified data) could hang or OOM the tab. Long lines
// almost never carry meaningful inline markdown, so render them as plain text.
const MAX_INLINE_LINE = 2000;

function parseSpans(text: string, keyPrefix: string): ReactNode[] {
  if (text.length > MAX_INLINE_LINE) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  // Iterate via matchAll, NOT a manual `INLINE_RE.exec` loop. INLINE_RE is a
  // module-level regex with the `g` flag (stateful lastIndex), and parseSpans
  // recurses — bold/italic/link re-parse their inner content. With exec, each
  // recursive call resets and mutates the SHARED `INLINE_RE.lastIndex`; when it
  // returns, the outer loop's lastIndex has been clobbered to 0, so the next
  // exec re-scans from the start and re-matches the same token forever, pushing
  // unbounded elements until the tab OOMs. (This is the monty crash: its
  // formatting-heavy output is the first content to hit a bold/italic/link.)
  // matchAll iterates over an internal clone and never touches lastIndex, so
  // recursion is fully isolated.
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${k++}`;
    if (m[1]) {
      out.push(
        <code key={key} className="md-code">
          {m[2]}
        </code>,
      );
    } else if (m[3]) {
      out.push(<strong key={key}>{parseSpans(m[4], key)}</strong>);
    } else if (m[5]) {
      out.push(<em key={key}>{parseSpans(m[6], key)}</em>);
    } else if (m[7] !== undefined) {
      out.push(
        <a key={key} href={sanitizeHref(m[8])} target="_blank" rel="noopener noreferrer">
          {parseSpans(m[7], key)}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Allow only http(s), mailto, and scheme-less (relative/fragment) hrefs; drop
// anything with another scheme (javascript:, data:, …) to a no-op link.
function sanitizeHref(href: string): string {
  const t = href.trim();
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return "#";
  return t;
}
