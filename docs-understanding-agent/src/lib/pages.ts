import { config } from "../config";

export type ChangedFile = { filename: string; status: string };

const DOC_EXTENSIONS = [".md", ".mdx"];
const RELEVANT_STATUSES = new Set(["added", "modified", "changed", "renamed"]);

// A prefix without a trailing slash must still only match at a path segment
// boundary — otherwise "docs" would also match "docs-legacy/x.md".
const matchesPrefix = (path: string, prefix: string): boolean => {
  if (path === prefix) return true;
  const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(boundary);
};

export function filterDocsFiles(files: ChangedFile[]): string[] {
  return files
    .filter((f) => RELEVANT_STATUSES.has(f.status))
    .map((f) => f.filename)
    .filter((path) => config.docsPathPrefixes.some((prefix) => matchesPrefix(path, prefix)))
    .filter((path) => DOC_EXTENSIONS.some((ext) => path.endsWith(ext)));
}

// Convention-based mapping: strip the content root and extension, index files
// map to their directory. Framework-specific routing (slugs in frontmatter,
// Next.js route groups) is out of scope.
export function filePathToRoute(path: string): string {
  let route = path;
  if (config.docsContentRoot && matchesPrefix(route, config.docsContentRoot)) {
    route = route.slice(config.docsContentRoot.length);
  }
  route = route.replace(/\.(md|mdx)$/, "");
  route = route.replace(/\/index$/, "");
  if (!route.startsWith("/")) route = `/${route}`;
  return route;
}

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

const MAX_PAGE_CHARS = 20_000;

export async function fetchPageText(previewUrl: string, route: string): Promise<string> {
  // `new URL(route, previewUrl)` would drop any path component of previewUrl
  // since route starts with "/" (path-absolute URLs resolve against the
  // origin only). Resolve the route as a relative reference against
  // previewUrl normalized to end with "/" so a base path survives.
  const base = previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`;
  const url = new URL(route.replace(/^\//, ""), base).toString();
  const headers: Record<string, string> = { "User-Agent": "docs-understanding-agent" };
  if (config.previewBypassSecret) {
    headers["x-vercel-protection-bypass"] = config.previewBypassSecret;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }

  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const body = await res.text();

  if (res.status === 401 || body.includes("vercel.com/sso-api")) {
    throw new Error(
      `Preview at ${url} is protected by Vercel deployment protection. ` +
        `Set PREVIEW_BYPASS_SECRET (Vercel: Protection Bypass for Automation).`,
    );
  }
  if (!res.ok) {
    throw new Error(`Fetching ${url} failed with ${res.status}`);
  }

  // Prefer the page's main content region when it exists.
  const main = body.match(/<(main|article)[\s\S]*?<\/\1>/i);
  const text = stripHtml(main ? main[0] : body);
  if (!text) {
    throw new Error(`Fetched ${url} but extracted no text content`);
  }
  return text.slice(0, MAX_PAGE_CHARS);
}
