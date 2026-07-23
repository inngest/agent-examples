// Simulates the PR reviewer clicking a check-run button, resolving the
// deferred reviewer-feedback scorers parked on step.waitForEvent.
//
// Usage: bun run feedback [approve|needs_work] [sha]
import { inngest } from "../src/inngest/client";

const verdict = process.argv[2] ?? "approve";
const sha = process.argv[3] ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const result = await inngest.send({
  name: "github/review.feedback",
  data: {
    owner: "acme",
    repo: "docs",
    sha,
    checkRunId: 1,
    verdict,
    reviewer: "demo-user",
  },
});

console.log(`Sent github/review.feedback (verdict ${verdict}, sha ${sha.slice(0, 7)})`);
console.log(`Event IDs: ${result.ids.join(", ")}`);
