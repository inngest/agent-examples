// Fires a synthetic "preview deployed" event so the whole pipeline can be
// demoed without GitHub or Vercel. Run the server with DRY_RUN_GITHUB=1 so
// GitHub API calls are stubbed; pages are fetched from a real live site.
//
// Usage: bun run trigger [sha]
import { inngest } from "../src/inngest/client";

const sha = process.argv[2] ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const previewUrl = process.env.DEMO_PREVIEW_URL ?? "https://www.inngest.com";
// Override the synthetic changed-file list to exercise a real file on the
// live preview, e.g. DEMO_FILES=content/blog/some-post.md.
const files = process.env.DEMO_FILES
  ? process.env.DEMO_FILES.split(",")
      .map((f) => f.trim())
      .filter(Boolean)
  : [
      "docs/getting-started/express-quick-start.mdx",
      "docs/features/inngest-functions/steps-workflows/step-experiments.mdx",
    ];

const result = await inngest.send({
  id: `preview-${sha}-demo`,
  name: "github/preview.deployed",
  data: {
    owner: "acme",
    repo: "docs",
    sha,
    previewUrl,
    environment: "Preview",
    installationId: 0,
    // Consumed by the DRY_RUN_GITHUB stub as the PR's changed files.
    dryRun: { files },
  },
});

console.log(`Sent github/preview.deployed (sha ${sha.slice(0, 7)}, preview ${previewUrl})`);
console.log(`Event IDs: ${result.ids.join(", ")}`);
