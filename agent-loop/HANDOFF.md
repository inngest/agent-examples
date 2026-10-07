# Handoff: goal-loop status (2026-10-07, updated 17:00 UTC)

How to pick this work up on another machine. `BUILD_LOG.md` is the detailed history and the source for the blog post. This file covers where things stand and what to do next.

## What this is

A `/goal` loop on Inngest. A small model ports `golang.org/x/mod/semver` to TypeScript one attempt at a time, until a check it can't touch says the port matches Go. **Thesis of the post: the harness keeps going on long-running work even when the model misbehaves.** The model is deliberately imperfect, so prefer harness fixes over switching to a stronger model.

- `golden/`: Go generator for the ground-truth cases (`go run ./golden`, byte-identical on rerun).
- `data/`: 22,207 cases, content-addressed ids, split into train (17,752) and holdout (4,455) by `fnv32(id) % 5`.
- `check/`: the grader (`run-check.ts`, `runner.ts`, `score-core.ts`), the sandbox grader (`run-check-sandbox.ts`), selftests and fixtures.
- `src/inngest/`:
  - `goal-loop.ts`: baseline, then per attempt: invoke the attempt, check, keep or revert, and pause for review after enough stalls. Then holdout and `goal/finished`.
  - `agent-attempt.ts`: prepare, brief, turn loop (model call via `step.ai.wrap`, or `step.ai.infer` with MODEL_CALL=inngest; tool steps), commit. Helpers in `src/lib/` (loop-state, reasoning-ladder, history, model-call, workspace, openrouter).
- `WORKSPACE_BACKEND`:
  - `local`: a git repo in `workspace/`, with the check in a child process.
  - `sandbox`: files live in step state, typecheck runs on the worker, and the check runs in a fresh Inngest Sandbox. Cloud only.

## Current defaults

- Model: set by the `MODEL` env var on the worker, or per goal with `goal/started` `data.model`. The Render worker (`agent-loop/render.yaml`) uses `nvidia/nemotron-3.5-lightning` (non-thinking, fast, every turn a tool call under strict routing; reached 0.377–0.445 in 4–6 attempts in the local probes). The default is `qwen/qwen3-coder-30b-a3b-instruct` via OpenRouter. It's non-thinking, about $0.002 and a minute per attempt, and plateaus around 0.33 without help.
- `maxAttempts` 60, `maxStalls` 5, `maxTurnsPerAttempt` 8, `maxTokensPerTurn` 4000 (was 8000; real tool-call turns peak around 3.6k, and runaway whitespace turns ran to the cap).
- `tool_choice: "required"` and OpenRouter `provider.require_parameters`. Turns without a tool call don't count toward `maxTurnsPerAttempt`. They're tracked as `idleTurns` and capped at 4 per attempt. `edit_file` rejects edits that change nothing.
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
pnpm goal:watch -- --goal my-goal   # live TUI; also answers the review (see below)
```

### Live view: `pnpm goal:watch`

A pi-tui terminal UI (`scripts/watch-goal.ts` + `scripts/watch/`): a pass-rate chart with one column per attempt (green kept, yellow reverted, dim unchanged, red failed), the last attempts with Δ failing cases, and the attempt in flight (each turn and tool call). With no run of the goal in flight, `s` (or `--start`) starts one with the `goal:send` flags given (`--model`, `--max-attempts`, `--max-stalls`, `--max-tokens`); on the local backend it resets the shared workspace first, so don't press it while another local goal is running. When the loop parks for review, an editor opens, pre-filled with the last note (a review *replaces* the note, so it has to be resent): Enter = continue, Ctrl+S = stop. `q` quits. Quitting never affects the run.
- History comes from the REST events API (`src/lib/goal-history.ts`, bounded by the latest `goal/started` for the id). Live data comes from Inngest Realtime, channel `goal:<goalId>` (`src/inngest/channel.ts`), topics `loop` and `attempt`.
- Publishes (`src/lib/live.ts`) are their own memoized steps, swallowing errors, so a replay never re-sends and a realtime outage can't fail the goal. Tool-call messages publish from inside the tool step instead. goal-loop's step budget went from 7 to 9 per iteration (`MAX_ATTEMPTS_CAP` 141 → 110).
- Target follows `INNGEST_DEV` in `.env`; `--dev` / `--cloud` override it per session. The TUI only talks to Inngest (REST events, Realtime, event send), never to the worker. Full docs: `README.md`.

Gotchas:
- Start long-lived processes in your own terminal or with `nohup`. Never use a tool's background shell with a timeout: one killed the dev server mid-run, and without `--persist` all history was lost.
- Use GraphQL (`/v0/gql`, `runTrace`) for run status, not REST `/v1/events/{id}/runs`, which reported runs `Completed` while they were still running.
- `pnpm inngest` calls the native binary directly, because pnpm's JS shim for `inngest-cli` breaks.
- `tsx watch` does not respawn a worker that died from SIGKILL, and neither `touch` nor a real source edit woke it. Ctrl-C and rerun `pnpm dev`.
- Model calls run on the worker by default (`MODEL_CALL=worker`: OpenAI SDK in `step.ai.wrap`, 180s timeout, per-turn logs, `inngest.ai` + `model_call` trace metadata via the `@inngest/otel/node` preload). `MODEL_CALL=inngest` is `step.ai.infer`: the call runs on the Inngest server, finishes even while the worker is dead, but can hang with no timeout (01M4BT2HCB099CWVKRZ6FY8774) and logs nothing.
- On Cloud, a slow turn looks like a hang: `step.ai.infer` shows attempt 0 running with no error. Check provider throughput (OpenRouter routing) before suspecting Inngest; the harness now sends `provider.sort: "throughput"`.
- Cancelling an `agent-attempt` run from the dashboard counts as a stall (3d8fdb7); before that fix it crashed goal-loop.

## Deploy (Inngest Cloud + Render): live since 2026-10-07

1. ~~Confirm Sandbox access~~: confirmed 2026-10-07.
2. ~~Grader smoke test~~: `pnpm check:sandbox-smoke` passes (stub 1, lookup 0) and so does a multi-file solution. Sandboxes need ≥1024MB (512 returns 503 `compute_unavailable`). `INNGEST_DEV=0` counts as Cloud.
3. Optionally run the worker locally against Cloud with `pnpm start:worker` (Connect, no public URL needed).
4. ~~Render~~: `goal-loop-worker` is live (srv-db3698gm7kps73d69tk0, Inngest team workspace, auto-deploys on push to `mitch/goal-loop`); render-smoke-1 completed end to end. How it was set up: in Render (Inngest team workspace), create a **new** Blueprint from this repo, branch `mitch/goal-loop`, **Blueprint Path `agent-loop/render.yaml`**. It defines only `goal-loop-worker` and needs the secrets `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` and `MODEL_API_KEY`. Don't use the root `render.yaml`: it belongs to the live token-streaming-agent Blueprint on `mitch/render-deploy`, and a second Blueprint from it would duplicate those services.
5. Canon run: `pnpm goal:send -- --goal canon-3` with Cloud keys in `.env`. Screenshots come from the Cloud dashboard.

## Milestone status (spec §10)

| # | milestone | status |
|---|---|---|
| 1 | golden corpus | done |
| 2 | check + selftest | done (`check:selftest` all green) |
| 3 | single attempt | done (local) |
| 4 | loop happy path with reverts | done (local; canon-2, coder-probe-1) |
| 5 | kill and resume | done (local; kill-probe-2: SIGKILL mid-attempt, 15s outage, attempt resumed from memoized turns, one commit). kill-probe-1 shows the limit: a ~6 min outage outlasted goal-loop's retries and the goal FAILED. Budgets left as is by choice. |
| 6 | stall → review → resume | done (local; coder-probe-1 parked on `review-9` by itself, the note reached attempt 10's brief) |
| 7 | check change mid-run → rebaseline | done (local; rebase-probe-1: dropped Sort cases after attempt 2, `rebaseline-3` re-scored the incumbent under the new checkVersion) |
| 8 | holdout + numbers | done (local; holdout ≈ train, no overfitting) |
| v2 | sandbox backend + deploy | done (Render + Connect + Sandboxes; render-smoke-1/2, session-probe-1, canon-3) |

## Known issues / ideas

- Some providers don't enforce `tool_choice: "required"`. The share of turns without a tool call ranged from 0% to about 50% between runs. Those turns are now tracked as `idleTurns` and don't use up the turn budget. It's a post beat, not a bug.
- The model rarely calls `finish_attempt`, so most attempts use all 8 turns. Harmless, because the commit step saves the work either way.
- When nemotron does call `finish_attempt`, it's often before it has edited anything (a plan, not a change). Since 294e805 that finish is refused up to 2× per attempt (`EMPTY_FINISH_REFUSAL`). In canon-3 it took the run from 0 of 10 attempts improving to 4 of 6.
- A tool call cut off mid-arguments (`finish_reason: length`) used to be echoed back into the history, and the providers then rejected the next turn with 400 `function.arguments must be a valid JSON object` (non-retriable) → the attempt failed (canon-3 attempt 18). The history now gets `{}` for invalid arguments; the tool still answers "not valid JSON".
- Attempts carry context forward (journal of the last 5, regressions of the last reverted attempt, rotating example windows); see README "Why it keeps going" and BUILD_LOG. Not yet measured against the old brief.
- Unsticking (not yet measured): the brief inlines the current code; `edit_file` misses quote the closest lines; while any function fails every case the brief says to implement them all at once; after that each attempt focuses on one function (`pickFocus`: fewest unkept focused attempts, then most-failing; `--no-focus` to compare). canon-5 (first focus version) did worse than live-4; see BUILD_LOG.
- Any OpenRouter model: the `settings` step at goal start (fail fast on no tools / unknown slug; no `reasoning` where unsupported; budget under max_completion_tokens); in-attempt reasoning ladder (nudge → 2× budget → reasoning off), learned by later attempts. See README "Trying another model".
- Reasoning: `REASONING_EFFORT` / `REASONING_MAX_TOKENS` on the worker, or `--reasoning-effort` / `--reasoning-max-tokens` per goal. Phala already reasons and stops at ~2,001 reasoning tokens on ≥10% of turns; raise `--max-tokens` with it (reasoning counts against it).
- Sessions: `goal:send` tags `meta.sessions.goal_id`, which propagates to the invoked attempts (dashboard: AI > Sessions). The REST API doesn't return `meta`.
- The sandbox grader uploads every workspace file under `src/` (8bac4a5). Relative imports must use `.ts` specifiers; the in-memory typecheck rejects `./x.js`. Verified in a real sandbox.
- Durability limit: a worker outage longer than the retry window of the function that must run next fails the run (agent-attempt `retries: 2` ≈ 1 min; goal-loop default ≈ 4.5 min). State survives, but the run doesn't. Kept deliberately as a post finding.
- `write_file`/`edit_file` reject results that would leave a file empty (3081cb3); nemotron-3.5-lightning wrote empty files twice in the probes.
- checkVersion changed once in the sandbox refactor (`052e0be4bb9e` → `9ef47c667fd7`); the cases didn't change.
- Spec v2 follow-ups not started: chaining rounds across runs past the step limit, the small-vs-large model comparison post. (Review UI: `goal:watch`.)

## Working conventions (from the original session)

- Keep `BUILD_LOG.md` updated with every notable event (what broke, model behaviour, real numbers, timestamps). The post is written from it.
- Don't change code under a run you care about: `tsx watch` hot-reloads the worker. Change step `name`s only, never `id`s, while runs are in flight.
