import { experiment, type GroupTools } from "inngest";
import { config } from "../config";
import { getGitHub } from "../github/app";
import { CHECK_RUN_ACTIONS, formatCheckOutput, formatPRComment, type ModelResult, type PageResult } from "../github/checks";
import { summarize, type PageSummary } from "../lib/openrouter";
import { fetchPageText, filePathToRoute, filterDocsFiles } from "../lib/pages";
import { heuristicScore, judgeSummary } from "../lib/scoring";
import { inngest } from "./client";
import { reviewerFeedbackScorer } from "./scorers";

// `group.experiment()` doesn't export its `experimentRef` return type from
// the package root, so derive it from the public `GroupTools` type instead.
type ExperimentRef = Awaited<ReturnType<GroupTools["experiment"]>>["experimentRef"];

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

    // heuristics -> judge -> best-effort score writes; shared by both modes.
    // suffix = `${route}` (sample) or `${route}:${variant}` (compare).
    // Defined inside the handler so it can close over `step` and `runId`
    // directly instead of threading typed step tools through as arguments.
    const judgeAndScore = async (args: {
      suffix: string;
      pageText: string;
      summary: PageSummary;
      experimentRef: ExperimentRef;
    }) => {
      const { suffix, pageText, summary, experimentRef } = args;
      const heuristics = await step.run(`heuristics:${suffix}`, () => heuristicScore(summary));
      const judged = await step.run(`judge:${suffix}`, () => judgeSummary(pageText, summary));
      try {
        await step.score(`score-heuristics:${suffix}`, { name: "heuristics", value: heuristics });
        await step.score(`score-judge:${suffix}`, { name: "judge-clarity", value: judged.clarity });
        // Wrapped in a step so it's memoized: called at function-body level
        // (with an explicit runId instead) it would re-fire a real network
        // call on every replay of this loop. Explicit runId keeps the write
        // run-scoped so it still co-locates with the variant in the
        // experiment view.
        await step.run(`score-experiment:${suffix}`, () =>
          inngest.score.experiment({
            experiment: experimentRef,
            name: "judge-clarity",
            value: judged.clarity,
            runId,
          }),
        );
      } catch (scoreErr) {
        // Scoring is best-effort — don't let an exhausted score write blank
        // out the summary we already recorded for this model/page.
        console.warn(`score write failed for ${suffix}:`, scoreErr);
      }
      return { heuristics, judged };
    };

    const results: PageResult[] = [];
    for (const { path, route } of pages) {
      let pageText: string;
      try {
        pageText = await step.run(`fetch-page:${route}`, () => fetchPageText(previewUrl, route));
      } catch (err) {
        // A page that fails all retries shouldn't sink the rest of the PR.
        results.push({ path, route, models: [], error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      if (config.experimentMode === "compare") {
        // One `group.experiment` per model, all running in parallel — each
        // gets its own experimentRef so scores land per-model in the
        // experiment view, and a per-model try/catch means one bad model
        // can't reject the whole page.
        const models: ModelResult[] = await Promise.all(
          config.models.map(async ({ id, variant }): Promise<ModelResult> => {
            try {
              const { result: summary, experimentRef } = await group.experiment(`summarize:${route}:${variant}`, {
                variants: {
                  [variant]: () => step.run(`sum:${route}:${variant}`, () => summarize(id, pageText)),
                },
                select: experiment.fixed(variant),
              });
              const { heuristics, judged } = await judgeAndScore({
                suffix: `${route}:${variant}`,
                pageText,
                summary,
                experimentRef,
              });
              return { variant, summary, judgeClarity: judged.clarity, heuristics };
            } catch (err) {
              return {
                variant,
                summary: null,
                judgeClarity: null,
                heuristics: null,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );
        results.push({ path, route, models });

        // Reviewer-feedback rationale (compare mode, defer once,
        // unattributed): a single PR-level verdict credited to every model's
        // experimentRef would write identical, perfectly-correlated scores —
        // zero comparative signal, but it would look like each model
        // individually earned approval, which is misleading in exactly the
        // view compare mode is meant to make trustworthy. Deferring once per
        // page (no experiment ref) keeps the defer/waitForEvent/feedback demo
        // alive as an honest page-level signal, and avoids N identical parked
        // runs per page.
        defer(`reviewer-feedback:${route}`, {
          function: reviewerFeedbackScorer,
          data: { sha, owner, repo, route },
        });
      } else {
        try {
          // Only the selected variant runs; the experiment view compares
          // variants across pages and runs.
          const variantThunks: Record<string, () => Promise<PageSummary>> = {};
          const weights: Record<string, number> = {};
          for (const { id, variant } of config.models) {
            variantThunks[variant] = () => step.run(`sum:${route}:${variant}`, () => summarize(id, pageText));
            weights[variant] = 1; // equal weight across all configured models
          }
          const {
            result: summary,
            variant,
            experimentRef,
          } = await group.experiment(`summarize:${route}`, {
            variants: variantThunks,
            select: experiment.weighted(weights),
          });

          const { heuristics, judged } = await judgeAndScore({ suffix: route, pageText, summary, experimentRef });

          // A good summary is the valuable output of this loop iteration —
          // push it now so a scoring failure inside judgeAndScore can't
          // discard it (judgeAndScore already swallows score-write errors
          // internally, so this only guards the case above where heuristics
          // or judging itself failed and we never get here).
          results.push({ path, route, models: [{ variant, summary, judgeClarity: judged.clarity, heuristics }] });

          defer(`reviewer-feedback:${route}`, {
            function: reviewerFeedbackScorer,
            data: { sha, owner, repo, route, variant },
            experiment: experimentRef,
          });
        } catch (err) {
          results.push({
            path,
            route,
            models: [
              {
                variant: "—",
                summary: null,
                judgeClarity: null,
                heuristics: null,
                error: err instanceof Error ? err.message : String(err),
              },
            ],
          });
        }
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

    try {
      await step.run("post-pr-comment", async () => {
        const gh = await getGitHub(installationId, dryRun);
        await gh.upsertPRComment(owner, repo, pr.number, formatPRComment(previewUrl, results));
      });
    } catch (err) {
      // A flaky comment write shouldn't fail the whole run once retries burn
      // on GitHub API flakiness — the check run above already carries the
      // full output.
      console.warn(`post-pr-comment failed for PR #${pr.number}:`, err);
    }

    return {
      pr: pr.number,
      pages: results.map(({ route, models, error }) => ({
        route,
        models: models.map(({ variant, judgeClarity, heuristics, error: modelError }) => ({
          variant,
          judgeClarity,
          heuristics,
          ...(modelError ? { error: modelError } : {}),
        })),
        ...(error ? { error } : {}),
      })),
    };
  },
);

// Converges the two reviewer-feedback paths (check-run buttons and PR comment
// replies) onto the same `github/review.feedback` event the deferred scorers
// above wait on: resolve the PR's current head sha, then re-emit as feedback.
export const resolveCommentFeedback = inngest.createFunction(
  { id: "resolve-comment-feedback", triggers: [{ event: "github/review.comment" }] },
  async ({ event, step }) => {
    const { owner, repo, prNumber, verdict, reviewer, installationId } = event.data;

    const sha = await step.run("resolve-head-sha", async () => {
      const gh = await getGitHub(installationId);
      return gh.getPRHeadSha(owner, repo, prNumber);
    });

    await step.sendEvent("emit-feedback", {
      name: "github/review.feedback",
      data: { owner, repo, sha, verdict, reviewer },
    });
  },
);

export const functions = [analyzeDocsPreview, reviewerFeedbackScorer, resolveCommentFeedback];
