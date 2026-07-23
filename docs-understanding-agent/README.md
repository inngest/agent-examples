# docs-understanding-agent

When a PR gets a successful Vercel preview deploy, this agent reads every docs/blog
page the PR changed, has an LLM summarize what it understood, and asks: **did the PR
make this page easy for an LLM agent to understand?**

It demos four Inngest features in one pipeline:

| Feature | Where |
| --- | --- |
| [Express serve](https://www.inngest.com/docs/getting-started/express-quick-start) | `src/index.ts` |
| [Step experiments](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/step-experiments) — compare models via OpenRouter | `src/inngest/functions.ts` |
| [Scoring](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/scoring) — heuristics + LLM judge | `src/lib/scoring.ts` |
| [Deferred scoring](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring) — reviewer verdict via check-run buttons or PR comment reply | `src/inngest/scorers.ts` |

## Flow

```
PR opened ──▶ Vercel preview deploy ──▶ GitHub deployment_status webhook
                                              │
                                              ▼
                            inngest.send("github/preview.deployed")
                                              │
                          ┌───────────────────▼────────────────────┐
                          │ analyze-docs-preview                   │
                          │  1. sha → PR                           │
                          │  2. PR files → changed docs pages      │
                          │  3. create check run (in_progress)     │
                          │  4. per page:                          │
                          │     • fetch preview page               │
                          │     • group.experiment: summarize with │
                          │       one model (sample) or all models │
                          │       in parallel (compare)            │
                          │     • step.score: heuristics + judge   │
                          │     • defer(reviewer-feedback scorer)  │
                          │  5. finalize check run + PR comment    │
                          └───────────────────┬────────────────────┘
                                              │
       reviewer clicks "Approve"/"Needs work" on the check run, or replies
                  `/approve` / `/needs-work` on the PR
                                              │
      check_run.requested_action webhook, or issue_comment webhook (via
                     resolve-comment-feedback)
                                              │
                     inngest.send("github/review.feedback")
                                              │
              deferred scorers resolve → score attributed to variant
```

## Experiment modes

`EXPERIMENT_MODE` picks how `MODELS` is used, default `sample`:

- **sample** — `group.experiment` + `experiment.weighted` selects **one** model per
  page (today's original behavior). Cross-model comparison accumulates statistically
  across pages and runs in the Inngest experiment view; you never see two models'
  takes on the same page side-by-side.
- **compare** — one `group.experiment` per model, each with `experiment.fixed`, run
  in parallel on **every** page. Scores still land per-model in the experiment view,
  and the check run / PR comment additionally get a side-by-side table with the
  highest-judge model marked `(winner)`.

Reviewer feedback is only variant-attributed in sample mode: a single PR-level
`/approve` can't tell you which of several side-by-side models was actually right, so
compare mode's deferred scorer records an honest page-level verdict instead.

## Quick demo (no GitHub / Vercel needed)

Only `OPENROUTER_API_KEY` is required — `DRY_RUN_GITHUB=1` stubs the GitHub API and
pages are fetched from a real live site (default `https://www.inngest.com`).

```sh
bun install
cp .env.example .env   # set OPENROUTER_API_KEY

# terminal 1 — Inngest Dev Server (UI at http://localhost:8288)
bun run inngest

# terminal 2 — the app, with GitHub stubbed
bun run demo

# terminal 3
bun run trigger                 # synthetic "preview deployed" event
bun run feedback                # later: simulate the reviewer clicking Approve
bun run feedback needs_work     # ...or rejecting
```

Try compare mode instead by starting terminal 2 with `EXPERIMENT_MODE=compare bun run
demo`. `MODELS` overrides which OpenRouter models run (default
`anthropic/claude-sonnet-4.5,openai/gpt-4o`); `DEMO_FILES` overrides `bun run
trigger`'s synthetic changed-file list (comma-separated paths) so you can point the
demo at a real page on the preview site.

In the Dev Server UI watch the `analyze-docs-preview` run: in sample mode, the
`summarize:*` experiment picks a variant; in compare mode, one `summarize:*`
experiment per model runs in parallel. Either way `heuristics`/`judge-clarity` scores
land on the run, and one `reviewer-feedback` run per page parks on `wait-for-review`
until the feedback event arrives (timeout 7d) — variant-attributed in sample mode,
unattributed in compare mode.

## Real setup

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps):
   - Permissions: Checks **read/write**, Pull requests **read**, Issues **read/write**
     (posts and updates the sticky PR comment), Deployments **read**, Contents **read**.
   - Subscribe to events: **Deployment status**, **Check run**, **Issue comment**
     (reviewer replies of `/approve` / `/needs-work`).
   - Webhook URL: your server's `/api/github/webhooks` (locally: a `smee.io` channel, or
     `gh webhook forward --events deployment_status,check_run,issue_comment --repo <owner>/<repo> --url http://localhost:3000/api/github/webhooks`).
   - Set a webhook secret; generate a private key.
2. Install the app on the docs repo (which must be connected to Vercel for preview deploys).
3. Fill `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM or base64), `GITHUB_WEBHOOK_SECRET`,
   `OPENROUTER_API_KEY`; if the preview is protected, `PREVIEW_BYPASS_SECRET`
   (Vercel → Deployment Protection → Protection Bypass for Automation).
4. `bun run dev` + `bun run inngest`, open a PR touching `docs/**.mdx`, and watch the
   check run appear once the preview deploy succeeds.

File→route mapping is convention-based: `docs/foo/bar.mdx` → `/docs/foo/bar`
(`index` maps to the directory). Tune with `DOCS_PATH_PREFIXES` / `DOCS_CONTENT_ROOT`.

## Feedback

There are two equivalent ways for a reviewer to record whether the LLM's understanding
matched their intent — both resolve the same deferred `reviewer-feedback` scorer(s) via
`github/review.feedback`:

- **Check-run buttons** — click **Approve** / **Needs work** on the check run
  (`check_run.requested_action` webhook).
- **PR comment reply** — reply `/approve` or `/needs-work` on the PR (`issue_comment`
  webhook). The agent posts/updates a sticky comment with the same summary table on
  every deploy; comment replies go through `resolve-comment-feedback`, which resolves
  the PR's current head sha and re-emits `github/review.feedback` so it converges with
  the check-run path.

The comment path requires the GitHub App's Issues **read/write** permission and the
**Issue comment** webhook subscription (see Real setup above).

## Notes

- The experiment/scoring/defer APIs are **experimental** in the Inngest TS SDK —
  `inngest` is pinned to `4.12.1`; re-verify signatures before upgrading.
- The check run always concludes `neutral`: it's informational and never blocks a merge.
- Pages are analyzed sequentially in one run (capped by `MAX_PAGES`) so a PR maps to one
  check run and one trace. At real scale, fan out per page with `step.invoke` and
  aggregate check-run updates.
