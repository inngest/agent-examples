# agent-loop

A `/goal` loop on [Inngest](https://www.inngest.com): give a small, cheap model
a goal it can't reach in one go, and let a durable harness drive it there one
attempt at a time.

The goal here is concrete and checkable: **port Go's
[`golang.org/x/mod/semver`](https://pkg.go.dev/golang.org/x/mod/semver) to
TypeScript** so that it matches Go on 22,207 generated cases. The model writes
code through tools; a check it can't see or touch scores every attempt; the
loop keeps what got better, reverts what didn't, and pauses for a human when
the model is stuck.

The point is the harness, not the model. The model is deliberately small
(`nvidia/nemotron-3.5-lightning` via OpenRouter, roughly half a cent per
attempt) and it misbehaves in every way you'd expect: it plans instead of
editing, answers in chat instead of calling tools, writes empty files, gets
cut off mid tool call. **The loop keeps going anyway**: every one of those is
absorbed by the harness as a stall, a refused call or a revert, and the run
moves on. `BUILD_LOG.md` is the blow-by-blow history of building and running it.

```
goal/started
   │
   ▼
 baseline ──▶ ┌──────────────── attempt i ────────────────┐
              │ agent-attempt (step.invoke)               │
              │   turn 1..N: step.ai.infer → tool steps   │
              │   list_files · read_file · edit_file ·    │
              │   write_file · typecheck · finish_attempt │
              └───────────────────┬───────────────────────┘
                                  ▼
                  check (train cases, the model never sees it)
                                  ▼
          better than best? ── yes ──▶ keep  (stalls = 0)
                  │ no
                  ▼
            revert (stalls++) ── stalls ≥ maxStalls? ──▶ wait for goal/review.submitted
                                                         (a human note, or stop)
   … until the check passes or maxAttempts …
   ▼
 holdout check (cases no attempt ever saw) ──▶ goal/finished
```

## What's in here

| Path | What it is |
|---|---|
| `golden/` | Go program that generates the ground-truth cases from the real `semver` package (`go run ./golden`, byte-identical on rerun). |
| `data/` | The 22,207 cases, split into **train** (17,752, what the loop scores against) and **holdout** (4,455, scored once at the end) by a hash of each case id. |
| `check/` | The grader: runs a candidate `semver.ts` against the cases in a child process (`run-check.ts`, `runner.ts`, `score-core.ts`) or in a fresh [Inngest Sandbox](https://www.inngest.com/docs) (`run-check-sandbox.ts`), and builds the failure report the next attempt reads. Plus selftests. |
| `src/inngest/goal-loop.ts` | The loop: baseline, invoke an attempt, check, keep or revert, pause for review, holdout, `goal/finished`. |
| `src/inngest/agent-attempt.ts` | One attempt: model turns through `step.ai.infer`, each tool call its own step. |
| `src/inngest/tools.ts` | The six tools and their guard rails. |
| `src/inngest/channel.ts` | The Realtime channel the TUI subscribes to. |
| `scripts/watch-goal.ts` | The TUI (`pnpm goal:watch`). |
| `workspace-template/` | The stub project each goal starts from. |

## Why it keeps going: the harness

Every piece of state the loop needs lives in Inngest step results, so a worker
crash, a redeploy or a cancelled attempt replays from memoized steps instead of
starting over. On top of that, each misbehaviour we hit has a specific answer:

| The model… | The harness… |
|---|---|
| answers in chat instead of calling a tool | sends `tool_choice: "required"`; turns without a tool call don't use the turn budget, are counted as `idleTurns`, and are capped at 4 per attempt |
| calls `finish_attempt` with a plan before editing anything | refuses that finish (up to twice per attempt) and tells it to make the change |
| makes things worse | is reverted; the next attempt starts from the best code |
| changes nothing | costs a stall, with no check run |
| writes an empty file, or an edit that changes nothing | gets an error back from the tool instead |
| gets cut off mid tool call | gets a "not valid JSON" tool result; the broken arguments are kept out of the history so the provider doesn't reject the next request |
| stalls `maxStalls` times in a row | parks the goal on `step.waitForEvent` (up to 3 days) until a human sends a note, which goes into every later attempt's brief |
| keeps failing the same way, or the attempt crashes / is cancelled | counts as a stall; the goal never fails because of one attempt |

The check itself is out of reach: attempts see only its report (failures by
function plus the shortest failing examples), never the cases. The holdout set
is scored once, on the final best, so overfitting to the train report shows up
as a gap between the two numbers.

## Quick start (local dev server)

Needs Node ≥ 20 and pnpm. Go is only needed to regenerate `data/`.

```sh
cd agent-loop
pnpm install
cp .env.example .env        # set MODEL_API_KEY (an OpenRouter key)
pnpm check:selftest         # must be all green
pnpm check:tools
```

`.env` for local runs:

```sh
MODEL=nvidia/nemotron-3.5-lightning
MODEL_PROVIDERS=Phala        # see "Model × provider" below
INNGEST_DEV=1
WORKSPACE_BACKEND=local
```

Then three terminals:

```sh
pnpm inngest                 # 1: Inngest dev server, dashboard at http://localhost:8288
pnpm dev                     # 2: the worker on :3000
pnpm goal:watch -- --goal my-first-goal --start --max-attempts 10 --max-stalls 3   # 3: the TUI
```

`--start` resets the local workspace to the stubs and sends `goal/started`;
the TUI then shows the run live. Without the TUI, `pnpm workspace:reset` and
`pnpm goal:send -- --goal my-first-goal` do the same.

Start long-lived processes (`pnpm inngest`, `pnpm dev`) in your own terminals.
`pnpm inngest` runs with `--persist`, so run history survives a restart.

## The TUI: `pnpm goal:watch`

A terminal UI (built with [pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui))
that shows one goal looping, starts it, and lets you answer its review
without leaving the terminal.

```sh
pnpm goal:watch -- --goal <id> [--dev | --cloud] [--start] [goal flags]
```

```
goal-loop canon-3  Inngest Cloud  nvidia/nemotron-3.5-lightning  attempt 22/60  stalls 1/5  best 0.337  $0.116  ● live

 70% ┤                 ▁▁▁▁
     │             ▃▆▆▂█████
     │             █████████
     │             █████████
     │ ▃▃▃▃▂▃▃▃▃▃ ▃█████████
 45% ┤ ██████████·██████████
       pass rate per attempt · kept reverted unchanged failed

  #17 kept        5993/17752 failing  0.338     -225  turns 5 idle 1  $0.0033
  #18 failed      5993/17752 failing  0.338           turns 0 idle 0  $0.0000
  #19 unchanged   5993/17752 failing  0.338           turns 5 idle 4  $0.0106
  #20 kept        5987/17752 failing  0.337       -6  turns 4 idle 3  $0.0098
  #21 reverted    6029/17752 failing  0.340      +42  turns 8 idle 2  $0.0123

attempt 22 running 1m12s
  t1  1 tool call  182 tok
  t1.1 read_file      // Port of golang.org/x/mod/semver. Match the Go behavior exactly…
  t2  1 tool call  1277 tok
  t2.1 edit_file      edited semver.ts (2494 bytes) typecheck: ok
q quit
```

What's on screen:

- **Header:** goal id, target (dev server or Inngest Cloud), model, attempt
  number, stall counter against the review threshold, best score (the train
  fail rate, lower is better), total cost so far, and the live connection state.
- **Chart:** one column per attempt, taller is better (pass rate). Green is
  kept, yellow reverted, dim unchanged, red failed (the attempt crashed or was
  cancelled). The axis spans the kept attempts' range so small gains stay
  visible; an attempt far below it (a broken edit) shows as a dot on the floor.
- **Table:** the last attempts with failing cases, Δ failing cases against the
  best before that attempt, turns, idle turns and cost.
- **Live pane:** the attempt in flight, one line per model turn (tool calls,
  tokens, or `no tool call (cut off at the token limit)`) and per tool call
  (name and result; errors in red). `finish refused` marks a refused early finish.

### Starting a goal

When the goal has no run in flight, the footer shows what `s` would start:

```
s start model nvidia/nemotron-3.5-lightning, 10 attempts, 3 stalls, 4000 tok/turn, resets workspace  ·  q quit
```

Press `s`, or pass `--start` to start right away. It takes the same goal flags
as `goal:send`:

| Flag | Default | Meaning |
|---|---|---|
| `--model <slug>` | `MODEL` on the worker | OpenRouter model slug |
| `--max-attempts N` | 60 | attempts before the goal ends (capped at 110 by the step limit) |
| `--max-stalls N` | 5 | attempts in a row without improvement before the review pause |
| `--max-tokens N` | 4000 | output token limit per model turn |

On the dev server with the local backend, starting resets the shared
`workspace/` to the stubs first. There is one workspace per machine, so don't
start a local goal while another local goal is running. On Cloud (sandbox
backend) every attempt is seeded from step state and nothing is reset.

Starting a goal id that already ran starts a new run under the same id; the TUI
always shows the latest run of an id.

### Answering a review

When the loop parks, the live pane turns into a review pane with what you need
to write a useful note:

- **What still fails:** the best attempt's check report, the same one every
  attempt reads: failures by function, then the shortest failing examples.
- **What the stalled attempts tried:** each one's own `finish_attempt` summary
  and outcome.
- An editor, pre-filled with the previous note. A review **replaces** the note,
  so keep what still applies and add to it.

Enter sends `goal/review.submitted` with `continue` and your note; Alt+Enter
adds a new line; Ctrl+S sends `stop` (the loop scores the holdout and
finishes). Good notes state a rule the model keeps missing ("a prerelease
sorts before its release"), not a single case to special-case.

### Dev server or Cloud

The TUI goes where `INNGEST_DEV` in `.env` points: set (`1` or a URL) means
the dev server, unset / `0` / `false` means Inngest Cloud. `--dev` and
`--cloud` override it for one session, so the same checkout can watch both:

```sh
pnpm goal:watch -- --goal canon-3 --cloud      # needs INNGEST_SIGNING_KEY + INNGEST_EVENT_KEY in .env
pnpm goal:watch -- --goal my-goal --dev        # localhost:8288, no keys
```

**The TUI never needs the worker's address.** It only talks to Inngest:

| What | How |
|---|---|
| history (everything before the TUI opened) | the REST events API: `goal/started`, `goal/attempt.scored`, `goal/review.submitted`, `goal/finished` for the id, from the latest `goal/started` on |
| live updates | an Inngest Realtime subscription to channel `goal:<goalId>`, topics `loop` and `attempt` |
| start / review / stop | events sent to Inngest, which routes them to whatever worker is connected |

The worker publishes to that channel from inside the functions
(`src/lib/live.ts`). Each publish is its own memoized step that swallows
errors, so a replay never re-sends a message and a Realtime problem can never
fail or retry a goal. Quitting the TUI (`q` or Ctrl+C) only closes the
subscription; the run doesn't know or care whether anyone is watching.

## Running on Inngest Cloud

The deployed shape is a long-lived [Connect](https://www.inngest.com/docs/setup/connect)
worker (`src/worker.ts`): it dials out to Inngest over a WebSocket, so it needs
no public URL. Attempts are graded in Inngest Sandboxes (`WORKSPACE_BACKEND=sandbox`),
with the files carried in step state instead of a git repo.

1. Your Inngest account needs Sandbox access. Check with
   `pnpm check:sandbox-smoke` (Cloud keys in `.env`, `INNGEST_DEV` unset).
2. Deploy the worker. `render.yaml` here is a Render Blueprint for one Docker
   worker service (`goal-loop-worker`); set `INNGEST_SIGNING_KEY`,
   `INNGEST_EVENT_KEY` and `MODEL_API_KEY` as secrets. Any host that can run
   `node --import tsx src/worker.ts` from the `Dockerfile` works.
3. Watch and start goals from your machine with `pnpm goal:watch -- --cloud …`.

## Configuration

| Env var | Default | |
|---|---|---|
| `MODEL_API_KEY` | (none) | OpenRouter key (falls back to `OPENROUTER_API_KEY`) |
| `MODEL` | `qwen/qwen3-coder-30b-a3b-instruct` | default agent model |
| `MODEL_PROVIDERS` | unset | OpenRouter providers to prefer, comma-separated, tried in order. Unset: the fastest provider that supports every parameter |
| `MODEL_BASE_URL` | OpenRouter | any OpenAI-compatible endpoint |
| `INNGEST_DEV` | (unset = Cloud) | `1` for the dev server |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | | Cloud only |
| `WORKSPACE_BACKEND` | `local` | `local` (git repo in `workspace/`, check in a child process) or `sandbox` (Cloud only) |

Per goal, `goal/started` also accepts `maxTurnsPerAttempt` (default 8), and
`reasoningEffort` / `reasoningMaxTokens` for thinking models (opt-in; sending
`reasoning` to a non-thinking model makes OpenRouter find no provider).

## Model × provider

With open-weights models, "the model" is really the model *and whoever serves
it*. Replaying one exact nemotron request five times per provider: one
provider ran away (thousands of tokens of whitespace until the token limit),
re-listed files or sent edits with empty strings; another made the right edit
5 out of 5 times. Across a day of runs, one provider's turns ran away 24% of
the time and the other's never did. The harness absorbs bad turns, but they
cost attempts, so pin providers that behave with `MODEL_PROVIDERS`, and check
`provider` in the turn outputs (or `scripts/trace-dump.py`) when a model
suddenly gets worse.

## Scripts

| Command | |
|---|---|
| `pnpm goal:watch -- --goal <id> …` | the TUI (see above) |
| `pnpm goal:send -- --goal <id> …` | send `goal/started` without the TUI (same flags) |
| `pnpm workspace:reset` | recreate `workspace/` from the stubs (local backend) |
| `pnpm inngest` / `pnpm dev` | dev server / worker for local runs |
| `pnpm start:worker` | the Connect worker (what Cloud runs) |
| `pnpm check:selftest` / `pnpm check:tools` | grader and tool selftests |
| `pnpm check:sandbox-smoke` | grade the stub and a known-good solution in a real Sandbox |
| `pnpm check -- --commit <sha\|HEAD> --set train` | run the check by hand on a workspace commit |
| `python3 scripts/trace-dump.py <since ISO time>` | per-attempt scores, costs, turns and tool calls from the dev server |
| `pnpm typecheck` | `tsc --noEmit` |

Answering a review without the TUI:

```sh
curl -s -X POST localhost:8288/e/test -H 'content-type: application/json' \
  -d '{"name":"goal/review.submitted","data":{"goalId":"my-goal","action":"continue","note":"..."}}'
```

## Limits and gotchas

- **Step limit.** Inngest caps a run at 1,000 steps, which caps a goal at 110
  attempts. Chaining runs past that isn't built.
- **Outages longer than the retries.** State always survives a worker outage,
  but if the worker is gone longer than the retry window of the function that
  has to run next (about a minute for an attempt, about 4.5 minutes for the
  loop), the run fails.
- **Don't change step ids under a run you care about.** `tsx watch` hot-reloads
  the worker; renaming a step's display `name` is fine, changing its `id` isn't.
- **A slow turn looks like a hang.** `step.ai.infer` runs the model call on
  the Inngest side, so a slow provider shows as a turn "running" with no error.
  Check the provider's throughput before suspecting anything else.

See `HANDOFF.md` for current status and `BUILD_LOG.md` for the full history.
