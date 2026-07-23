import { App } from "octokit";
import { config } from "../config";
import type { ChangedFile } from "../lib/pages";
import { COMMENT_MARKER, type CheckRunOutput } from "./checks";

export type PullRequestRef = { number: number; title: string; headSha: string };

// The minimal GitHub surface the pipeline needs. Real mode wraps an
// installation-authenticated Octokit; DRY_RUN_GITHUB=1 swaps in a stub so the
// whole workflow runs without GitHub credentials.
export type GitHubClient = {
  listPRsForCommit(owner: string, repo: string, sha: string): Promise<PullRequestRef[]>;
  listPRFiles(owner: string, repo: string, prNumber: number): Promise<ChangedFile[]>;
  createCheckRun(owner: string, repo: string, headSha: string): Promise<number>;
  completeCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    output: CheckRunOutput,
    actions: { label: string; identifier: string; description: string }[],
  ): Promise<void>;
  upsertPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
  getPRHeadSha(owner: string, repo: string, prNumber: number): Promise<string>;
};

export type DryRunData = { files?: string[] };

let app: App | undefined;
const getApp = (): App => {
  if (!config.github.appId || !config.github.privateKey) {
    throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not set (or use DRY_RUN_GITHUB=1)");
  }
  app ??= new App({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    webhooks: { secret: config.github.webhookSecret || "unused" },
  });
  return app;
};

const realClient = async (installationId: number): Promise<GitHubClient> => {
  const octokit = await getApp().getInstallationOctokit(installationId);
  return {
    async listPRsForCommit(owner, repo, sha) {
      const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: sha,
      });
      return data
        .filter((pr) => pr.state === "open")
        .map((pr) => ({ number: pr.number, title: pr.title, headSha: pr.head.sha }));
    },
    async listPRFiles(owner, repo, prNumber) {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return files.map((f) => ({ filename: f.filename, status: f.status }));
    },
    async createCheckRun(owner, repo, headSha) {
      const { data } = await octokit.rest.checks.create({
        owner,
        repo,
        head_sha: headSha,
        name: "docs-understanding",
        status: "in_progress",
      });
      return data.id;
    },
    async completeCheckRun(owner, repo, checkRunId, output, actions) {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: "neutral",
        output,
        actions,
      });
    },
    async upsertPRComment(owner, repo, prNumber, body) {
      // Sticky comment: find our marker among existing comments and update it
      // in place rather than posting a new one on every deploy.
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });
      const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
      if (existing) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      } else {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      }
    },
    async getPRHeadSha(owner, repo, prNumber) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return data.head.sha;
    },
  };
};

const dryRunClient = (dryRun: DryRunData): GitHubClient => ({
  async listPRsForCommit(_owner, _repo, sha) {
    return [{ number: 1, title: "Dry-run PR", headSha: sha }];
  },
  async listPRFiles() {
    return (dryRun.files ?? []).map((filename) => ({ filename, status: "modified" }));
  },
  async createCheckRun(owner, repo, headSha) {
    console.log(`[dry-run] create check run on ${owner}/${repo}@${headSha.slice(0, 7)}`);
    return 1;
  },
  async completeCheckRun(_owner, _repo, checkRunId, output) {
    console.log(`[dry-run] complete check run #${checkRunId}: ${output.title}`);
    console.log(output.summary);
    console.log(output.text);
  },
  async upsertPRComment(_owner, _repo, _prNumber, body) {
    console.log(`[dry-run] sticky PR comment:`);
    console.log(body);
  },
  async getPRHeadSha() {
    // The demo exercises comment feedback via fake-feedback.ts instead of a
    // real sha match, so a fixed fake sha is fine here.
    return "0".repeat(40);
  },
});

export async function getGitHub(installationId: number, dryRun?: DryRunData): Promise<GitHubClient> {
  if (config.dryRunGithub) return dryRunClient(dryRun ?? {});
  return realClient(installationId);
}
