# Handoff: goal-loop status (2026-10-07)

How to pick this work up on another machine. `BUILD_LOG.md` is the detailed history and the source for the blog post. This file covers where things stand and what to do next.

## What this is

A `/goal` loop on Inngest. A small model ports `golang.org/x/mod/semver` to TypeScript one attempt at a time, until a check it can't touch says the port matches Go. **Thesis of the post: the harness keeps going on long-running work even when the model misbehaves.** The model is deliberately imperfect, so prefer harness fixes over switching to a stronger model.

- `golden/`: Go generator for the ground-truth cases (`go run ./golden`, byte-identical on rerun).
- `data/`: 22,207 cases, content-addressed ids, split into train (17,752) and holdout (4,455) by `fnv32(id) % 5`.
- `check/`: the grader (`run-check.ts`, `runner.ts`, `score-core.ts`), the sandbox grader (`run-check-sandbox.ts`), selftests and fixtures.
- `src/inngest/`:
  - `goal-loop.ts`: baseline, then per attempt: invoke the attempt, check, keep or revert, and pause for review after enough stalls. Then holdout and `goal/finished`.
  - `agent-attempt.ts`: model turns through `step.ai.infer`, plus the tool steps.
- `WORKSPACE_BACKEND`:
  - `local`: a git repo in `workspace/`, with the check in a child process.
  - `sandbox`: files live in step state, typecheck runs on the worker, and the check runs in a fresh Inngest Sandbox. Cloud only.

## Current defaults

- Model: `qwen/qwen3-coder-30b-a3b-instruct` via OpenRouter. It's non-thinking, about $0.002 and a minute per attempt, and plateaus around 0.33 without help.
- `maxAttempts` 60, `maxStalls` 5, `maxTurnsPerAttempt` 8, `maxTokensPerTurn` 8000.
- `tool_choice: "required"` and OpenRouter `provider.require_parameters`.
- Reasoning controls (`reasoningEffort` / `reasoningMaxTokens`) are **opt-in per goal**. Only set them for thinking models such as `qwen/qwen3.8-27b`. Sending `reasoning` to a non-thinking model gets an OpenRouter 404 under strict routing.

## Setup on a new machine

```sh
git checkout mitch/goal-loop && cd agent-loop
pnpm install          # pnpm-workspace.yaml already approves esbuild + inngest-cli builds
cp .env.example .env  # set MODEL_API_KEY (OpenRouter)
pnpm check:selftest   # must be all green before any loop run
pnpm check:tools
```

Go is only needed to regenerate `data/` (not needed to run).

## Run locally (dev server)

```sh
pnpm workspace:reset           # fresh stubs; do this before every new goal (local backend shares one workspace)
pnpm inngest                   # dev server on :8288 with --persist (state in .inngest/)
pnpm dev                       # worker on :3000
pnpm goal:send -- --goal my-goal [--model ...] [--max-attempts N] [--max-stalls N]
# resume a run that's waiting for review:
curl -s -X POST localhost:8288/e/test -H 'content-type: application/json' \
  -d '{"name":"goal/review.submitted","data":{"goalId":"my-goal","action":"continue","note":"..."}}'
python3 scripts/trace-dump.py <since-ISO-time>   # per-attempt scores, costs, turns
```

Gotchas:
- Start long-lived processes in your own terminal or with `nohup`. Never use a tool's background shell with a timeout: one killed the dev server mid-run, and without `--persist` all history was lost.
- Use GraphQL (`/v0/gql`, `runTrace`) for run status, not REST `/v1/events/{id}/runs`, which reported runs `Completed` while they were still running.
- `pnpm inngest` calls the native binary directly, because pnpm's JS shim for `inngest-cli` breaks.

## Deploy (Inngest Cloud + Render), not yet done

1. **Confirm the Inngest account has Sandbox access.** A probe via the Inngest Cloud MCP returned `403 access_denied: Sandbox access is not enabled for this account`. It may have been a different account, so verify.
2. Grader smoke test: in `.env`, remove `INNGEST_DEV`, set `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` and `WORKSPACE_BACKEND=sandbox`, then run `pnpm check:sandbox-smoke`. It should report stub score 1 and lookup score 0. **This is the first real run of the sandbox grader.**
3. Optionally run the worker locally against Cloud with `pnpm start:worker` (Connect, no public URL needed).
4. In Render, create a Blueprint from this repo/branch. The `goal-loop-worker` service in the root `render.yaml` needs the secrets `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` and `MODEL_API_KEY`. **The Docker image has never been built** (Docker wasn't installed on the dev machine), so Render's build is the first test.
5. Canon run: `pnpm goal:send -- --goal canon-3` with Cloud keys in `.env`. Screenshots come from the Cloud dashboard.

## Milestone status (spec §10)

| # | milestone | status |
|---|---|---|
| 1 | golden corpus | done |
| 2 | check + selftest | done (`check:selftest` all green) |
| 3 | single attempt | done (local) |
| 4 | loop happy path with reverts | done (local; canon-2, coder-probe-1) |
| 5 | kill and resume (**record this**) | **not done**: worker restarts during hot reload worked, but no deliberate kill mid-attempt has been checked yet |
| 6 | stall → review → resume | done (local; coder-probe-1 parked on `review-9` by itself, the note reached attempt 10's brief) |
| 7 | check change mid-run → rebaseline | **not done** |
| 8 | holdout + numbers | done (local; holdout ≈ train, no overfitting) |
| v2 | sandbox backend + deploy | built and typechecked; **sandbox path, Connect worker and Docker image are all untested live** |

## Known issues / ideas

- About half the coder model's turns end without a tool call even with `tool_choice: "required"`. Providers accept the setting but don't enforce it. The nudge recovers each time at the cost of a turn. It's a post beat, not a bug.
- The model rarely calls `finish_attempt`, so most attempts use all 8 turns. Harmless, because the commit step saves the work either way.
- An attempt that changed nothing still runs a check and a no-op revert. That's a small optimisation.
- The sandbox grader only uploads `semver.ts`, so a solution split across multiple files would fail to load there.
- checkVersion changed once in the sandbox refactor (`052e0be4bb9e` → `9ef47c667fd7`); the cases didn't change.
- Spec v2 follow-ups not started: chaining rounds across runs past the step limit, a review UI, the small-vs-large model comparison post.

## Working conventions (from the original session)

- Keep `BUILD_LOG.md` updated with every notable event (what broke, model behaviour, real numbers, timestamps). The post is written from it.
- Don't change code under a run you care about: `tsx watch` hot-reloads the worker. Change step `name`s only, never `id`s, while runs are in flight.
