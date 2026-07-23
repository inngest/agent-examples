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
| [Deferred scoring](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/deferred-scoring) — reviewer verdict via check-run buttons | `src/inngest/scorers.ts` |

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
                          │       one of 3 models (OpenRouter)     │
                          │     • step.score: heuristics + judge   │
                          │     • defer(reviewer-feedback scorer)  │
                          │  5. finalize check run + buttons       │
                          └───────────────────┬────────────────────┘
                                              │
              reviewer clicks "Approve"/"Needs work" on the check run
                                              │
                     check_run.requested_action webhook
                                              │
                     inngest.send("github/review.feedback")
                                              │
              deferred scorers resolve → score attributed to variant
```

Note on experiments: `group.experiment()` runs **one** selected variant per page.
Cross-model comparison shows up in the Inngest experiment view as variants accumulate
across pages and runs — it is not a side-by-side per page.

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

In the Dev Server UI watch the `analyze-docs-preview` run: the `summarize:*`
experiment picks a variant, `heuristics`/`judge-clarity` scores land on the run, and
one `reviewer-feedback` run per page parks on `wait-for-review` until the feedback
event arrives (timeout 7d).

## Real setup

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps):
   - Permissions: Checks **read/write**, Pull requests **read**, Deployments **read**, Contents **read**.
   - Subscribe to events: **Deployment status**, **Check run**.
   - Webhook URL: your server's `/api/github/webhooks` (locally: a `smee.io` channel, or
     `gh webhook forward --events deployment_status,check_run --repo <owner>/<repo> --url http://localhost:3000/api/github/webhooks`).
   - Set a webhook secret; generate a private key.
2. Install the app on the docs repo (which must be connected to Vercel for preview deploys).
3. Fill `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM or base64), `GITHUB_WEBHOOK_SECRET`,
   `OPENROUTER_API_KEY`; if the preview is protected, `PREVIEW_BYPASS_SECRET`
   (Vercel → Deployment Protection → Protection Bypass for Automation).
4. `bun run dev` + `bun run inngest`, open a PR touching `docs/**.mdx`, and watch the
   check run appear once the preview deploy succeeds.

File→route mapping is convention-based: `docs/foo/bar.mdx` → `/docs/foo/bar`
(`index` maps to the directory). Tune with `DOCS_PATH_PREFIXES` / `DOCS_CONTENT_ROOT`.

## Notes

- The experiment/scoring/defer APIs are **experimental** in the Inngest TS SDK —
  `inngest` is pinned to `4.12.1`; re-verify signatures before upgrading.
- The check run always concludes `neutral`: it's informational and never blocks a merge.
- Pages are analyzed sequentially in one run (capped by `MAX_PAGES`) so a PR maps to one
  check run and one trace. At real scale, fan out per page with `step.invoke` and
  aggregate check-run updates.
