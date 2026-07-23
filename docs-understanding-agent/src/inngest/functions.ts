import { experiment } from "inngest";
import { config } from "../config";
import { getGitHub } from "../github/app";
import { CHECK_RUN_ACTIONS, formatCheckOutput, type PageResult } from "../github/checks";
import { summarize } from "../lib/openrouter";
import { fetchPageText, filePathToRoute, filterDocsFiles } from "../lib/pages";
import { heuristicScore, judgeSummary } from "../lib/scoring";
import { inngest } from "./client";
import { reviewerFeedbackScorer } from "./scorers";

export const analyzeDocsPreview = inngest.createFunction(
  {
    id: "analyze-docs-preview",
    triggers: [{ event: "github/preview.deployed" }],
    // Vercel can emit several success events per deploy; one run per commit.
    idempotency: "event.data.sha",
    concurrency: 3,
    retries: 3,
  },
  async ({ event, step, group, defer, runId }) => {
    const { owner, repo, sha, previewUrl, installationId, dryRun } = event.data;

    const pr = await step.run("resolve-pr", async () => {
      const gh = await getGitHub(installationId, dryRun);
      const prs = await gh.listPRsForCommit(owner, repo, sha);
      return prs[0] ?? null;
    });
    if (!pr) return { skipped: `no open PR for ${sha}` };

    const pages = await step.run("list-changed-docs", async () => {
      const gh = await getGitHub(installationId, dryRun);
      const files = await gh.listPRFiles(owner, repo, pr.number);
      const mapped = filterDocsFiles(files).map((path) => ({ path, route: filePathToRoute(path) }));
      // Two files can map to the same route (docs/foo.mdx + docs/foo/index.mdx);
      // keep the first and drop later duplicates before capping the page count.
      const seenRoutes = new Set<string>();
      const deduped = mapped.filter(({ route }) => {
        if (seenRoutes.has(route)) return false;
        seenRoutes.add(route);
        return true;
      });
      return deduped.slice(0, config.maxPages);
    });
    if (pages.length === 0) return { skipped: "no docs/blog files changed" };

    const checkRunId = await step.run("create-check-run", async () => {
      const gh = await getGitHub(installationId, dryRun);
      return gh.createCheckRun(owner, repo, pr.headSha);
    });

    const results: PageResult[] = [];
    for (const { path, route } of pages) {
      try {
        const pageText = await step.run(`fetch-page:${route}`, () => fetchPageText(previewUrl, route));

        // Only the selected variant runs; the experiment view compares
        // variants across pages and runs.
        const { result: summary, variant, experimentRef } = await group.experiment(`summarize:${route}`, {
          variants: {
            "claude-sonnet": () =>
              step.run(`sum-claude:${route}`, () => summarize("anthropic/claude-sonnet-4.5", pageText)),
            "gpt-4o": () => step.run(`sum-gpt4o:${route}`, () => summarize("openai/gpt-4o", pageText)),
          },
          select: experiment.weighted({ "claude-sonnet": 50, "gpt-4o": 50}),
        });

        const heuristics = await step.run(`heuristics:${route}`, () => heuristicScore(summary));
        const judged = await step.run(`judge:${route}`, () => judgeSummary(pageText, summary));

        // A good summary is the valuable output of this loop iteration — push
        // it now so a scoring failure below can't discard it by falling
        // through to the outer catch's `summary: null` result.
        results.push({ path, route, variant, summary, judgeClarity: judged.clarity, heuristics });

        try {
          await step.score(`score-heuristics:${route}`, { name: "heuristics", value: heuristics });
          await step.score(`score-judge:${route}`, { name: "judge-clarity", value: judged.clarity });
          // Wrapped in a step so it's memoized: called at function-body level
          // (with an explicit runId instead) it would re-fire a real network
          // call on every replay of this loop. Explicit runId keeps the write
          // run-scoped so it still co-locates with the variant in the
          // experiment view.
          await step.run(`score-experiment:${route}`, () =>
            inngest.score.experiment({ experiment: experimentRef, name: "judge-clarity", value: judged.clarity, runId }),
          );

          defer(`reviewer-feedback:${route}`, {
            function: reviewerFeedbackScorer,
            data: { sha, owner, repo, route, variant },
            experiment: experimentRef,
          });
        } catch (scoreErr) {
          // Scoring is best-effort — don't let an exhausted score write blank
          // out the summary we already recorded above.
          console.warn(`score write failed for ${route}:`, scoreErr);
        }
      } catch (err) {
        // A page that fails all retries shouldn't sink the rest of the PR.
        results.push({
          path,
          route,
          variant: "—",
          summary: null,
          judgeClarity: null,
          heuristics: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await step.run("finalize-check-run", async () => {
      const gh = await getGitHub(installationId, dryRun);
      const output = formatCheckOutput(previewUrl, results);
      try {
        await gh.completeCheckRun(owner, repo, checkRunId, output, CHECK_RUN_ACTIONS);
      } catch (err) {
        // Don't strand the check run in "in_progress" forever — retry once
        // with a minimal output so it still completes even if the full
        // output was rejected (e.g. GitHub's size limits) or the API call
        // otherwise failed.
        console.error(`finalize-check-run: completeCheckRun failed, retrying with degraded output:`, err);
        await gh.completeCheckRun(
          owner,
          repo,
          checkRunId,
          { title: output.title, summary: "Output too large — see run logs.", text: "" },
          CHECK_RUN_ACTIONS,
        );
      }
    });

    return {
      pr: pr.number,
      pages: results.map(({ route, variant, judgeClarity, heuristics, error }) => ({
        route,
        variant,
        judgeClarity,
        heuristics,
        ...(error ? { error } : {}),
      })),
    };
  },
);

export const functions = [analyzeDocsPreview, reviewerFeedbackScorer];
