import { App } from "octokit";
import { config } from "../config";
import type { ChangedFile } from "../lib/pages";
import type { CheckRunOutput } from "./checks";

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
});

export async function getGitHub(installationId: number, dryRun?: DryRunData): Promise<GitHubClient> {
  if (config.dryRunGithub) return dryRunClient(dryRun ?? {});
  return realClient(installationId);
}
