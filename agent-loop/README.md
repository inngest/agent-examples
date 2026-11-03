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

**Walkthrough:** [Building a durable /goal agent loop that survives crashes](https://www.inngest.com/blog/building-a-durable-goal-agent-loop-that-survives-crashes)
on the Inngest blog covers how this was built and why the harness is shaped the way it is.

```
goal/started
   │
   ▼
 baseline ──▶ ┌──────────────── attempt i ────────────────┐
              │ coder agent, on its own sandbox           │
              │   loop(): model turn, then tool steps     │
              │   work_run · work_read · work_edit ·      │
              │   work_write · work_finish                │
              └───────────────────┬───────────────────────┘
                                  ▼
                  check (train cases, on a sandbox the model can't reach)
                                  ▼
          better than best? ── yes ──▶ keep  (stalls = 0)
                  │ no
                  ▼
            drop it (stalls++) ── stalls ≥ maxStalls? ──▶ wait for goal/review.submitted
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
| `check/` | The grader: runs a candidate against the cases (`runner.ts`) and scores the output (`score-core.ts`), building the failure report the next attempt reads. The goal grades on its grader sandbox (`grade.ts`); `run-check.ts` grades a file locally. Plus selftests. |
| `src/agents/goal.ts` | The goal, an agent on a thread per `goalId`: settings, baseline, then per attempt: start a coder, check, keep or drop, wait for review; holdout, `goal/finished`. Review notes reach its inbox at any time. |
| `src/agents/coder.ts` | One attempt, an agent: the model, its sandbox, and the loop options (tool call required, stop on `work_finish`, live updates per turn). |
| `src/sandboxes.ts` | The attempt's sandbox (seeded with the best code, committed to git, its tools) and the grader's. |
| `src/tools/` | `finish` (refused while nothing changed) and `typechecked`, which wraps the SDK's `edit` and `write` with the `src/` fix and a typecheck after each change. |
| `src/models/openrouter.ts` | The model: the loop's history as an OpenRouter chat request, provider routing, repaired history, and the reasoning ladder inside each call. |
| `src/inngest/events.ts`, `channel.ts` | The events (`goal/*`) and the Realtime channel the TUI subscribes to. |
| `src/lib/loop-state.ts` | What the loop carries between attempts, and the pure `afterAttempt` that updates it (outcome, journal, regressions, focus misses, stalls). |
| `src/lib/prompt.ts` | The system prompt and `buildBrief`: everything the model is told. |
| `src/lib/openrouter.ts` | What a model can do on OpenRouter (tools, reasoning, limits, context window). |
| `images/coder/` | The image of the attempt's sandbox: node, tsc, git. |
| `scripts/watch-goal.ts`, `scripts/watch/` | The TUI (`pnpm goal:watch`): wiring, state, rendering. |
| `data/spec.txt`, `scripts/gen-spec.ts` | Go's documentation for the package (pinned `golang.org/x/mod` v0.21.0, the version that made the cases); `pnpm spec:gen` regenerates it. In the brief with `--spec`. |
| `workspace-template/` | The stub project each goal starts from. |

## Why it keeps going: the harness

The goal and each attempt are [Inngest Agents](https://www.inngest.com/docs/labs/agents):
every model call, tool call and sandbox command is a durable step, so a worker
crash, a redeploy or a cancelled attempt replays from memoized steps instead of
starting over. On top of that, each misbehaviour we hit has a specific answer:

| The model… | The harness… |
|---|---|
| answers in chat instead of calling a tool | runs with `toolChoice: "required"`; turns without a tool call get a nudge, don't use the turn budget, are counted as `idleTurns`, and are capped at 4 per attempt |
| calls `work_finish` with a plan before editing anything | has that finish refused while `git status` shows no change, and is told to make the change |
| makes things worse | is dropped; the next attempt starts on a fresh sandbox from the best code |
| changes nothing | costs a stall, with no check run |
| writes an empty file, or an edit that changes nothing | gets an error back from the tool instead |
| gets cut off mid tool call | gets a schema error back; the broken arguments are kept out of the history so the provider doesn't reject the next request |
| thinks until it runs out of room, or pads a tool call with whitespace | is asked again within the same model call, one rung up: a nudge, then double the budget, then reasoning off; later attempts start on the rung that worked |
| stalls `maxStalls` times in a row | waits on the goal's inbox (up to 3 days) until a human sends a note, which goes into every later attempt's brief; a note sent while attempts run lands in the next brief |
| retries an approach that already failed | sees a journal of the last 5 attempts in its brief: each one's own summary, outcome and per-function change in failing cases |
| breaks cases that used to pass | is reverted, and the next brief lists the cases that attempt broke ("keep these passing") |
| stares at the same examples every attempt | gets a different window of 10 failing examples each attempt, rotating through a pool of 60 |
| spends its first turns reading files | gets the current code in its brief (up to 20,000 chars), so turn 1 can edit |
| writes to `src/semver.ts` (paths are relative to `src/`) | has the leading `src/` (or `./`) dropped instead of an error |
| gets `old_string` almost right | is told which lines are closest (or that only whitespace differs) and gets them quoted exactly, to copy; an ambiguous match lists its line numbers |
| implements a stub file one function at a time | is told which functions still fail every case and to implement them all in this attempt |
| rewrites everything and breaks as much as it fixes | once no function is a stub, gets one function to work on per attempt: the one with the fewest focused attempts that weren't kept, most-failing first among equals, so it moves on from a function it can't fix; off with `--no-focus` |
| crashes, or the attempt is cancelled | counts as a stall; the goal never fails because of one attempt |

The check itself is out of reach: it runs on a grader sandbox the goal lists
code-only, so the model has no tools on it. Attempts see only its report
(failures by function plus a capped sample of failing examples), never the
case files.
Everything carried from one attempt to the next comes from that train check
and the attempts' own summaries, so the context gets more useful without
showing any more of the train set than the report does, and none of the holdout. The holdout set
is scored once, on the final best, so overfitting to the train report shows up
as a gap between the two numbers.

## Quick start (local dev server)

Needs Node ≥ 20 and pnpm. Go is only needed to regenerate `data/`.

```sh
cd agent-loop
pnpm install
cp .env.example .env        # set MODEL_API_KEY (an OpenRouter key)
pnpm check:selftest         # must be all green
pnpm check:harness
```

`.env` for local runs:

```sh
MODEL=nvidia/nemotron-3.5-lightning
MODEL_PROVIDERS=Phala        # see "Model × provider" below
INNGEST_DEV=1
```

The attempts and the grader run on sandboxes, which the dev server runs
locally. Build the attempt's image once from `images/coder/` as
`semver-coder:v1`.

Then three terminals:

```sh
pnpm inngest                 # 1: Inngest dev server, dashboard at http://localhost:8288
pnpm dev                     # 2: the worker on :3000
pnpm goal:watch -- --goal my-first-goal --start --max-attempts 10 --max-stalls 3   # 3: the TUI
```

`--start` sends `goal/started`; the TUI then shows the run live. Without the
TUI, `pnpm goal:send -- --goal my-first-goal` does the same.

Start long-lived processes (`pnpm inngest`, `pnpm dev`) in your own terminals.
`pnpm inngest` runs with `--persist`, so run history survives a restart.

## The TUI: `pnpm goal:watch`

A terminal UI (built with [pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui))
that shows one goal looping, starts it, and lets you answer its review
without leaving the terminal.

```sh
pnpm goal:watch -- [--goal <id>] [--dev | --cloud] [--start] [--inline] [goal flags]
```

It takes over the whole window (the terminal's alternate screen, like `htop`):
the chart grows with the window, the live pane gets the spare rows, and the
key hints sit on the last row. Quitting gives the scrollback back. `--inline`
draws in the normal buffer instead.

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

attempt 22 running 1m12s · Phala  context █░░░░░░░░░░░ 9.0k / 262k (3%)
  t1  1 tool call  in 1.6k · out 182
  t1.1 read_file      // Port of golang.org/x/mod/semver. Match the Go behavior exactly…
  t2  1 tool call  in 4.2k · out 1.3k
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
- **Live pane:** the attempt in flight, with the provider that served it and a
  **context meter** (the latest turn's prompt plus output against that
  provider's context window, from OpenRouter's endpoints API; yellow above 50%,
  red above 80%). Then one line per model turn (tool calls, input and output
  tokens, or `no tool call (cut off at the token limit)`) and per tool call
  (name and result; errors in red). `finish refused` marks a refused early
  finish. Finished attempts show their peak context in the table (`ctx 4%`).
  Expect small numbers: every attempt starts from a fresh context, and what
  carries over is the best code and the check report, not the conversation.

### Starting a goal

Press `s` (when the goal has no run in flight) to open the start form, or run
`pnpm goal:watch` with no `--goal` and it opens at launch:

```
╭──────────────────────────────────────────────────────────────╮
│ Start a goal  on Inngest Cloud                               │
│                                                              │
│ ▸ Goal id               canon-14▏                            │
│   Model                 nvidia/nemotron-3.5-lightning        │
│   Attempts              20                                   │
│   Stalls before review  4                                    │
│   Tokens per turn       4000                                 │
│   Reasoning             worker default                       │
│   Focus                 on                                   │
│   Go docs in brief      off                                  │
│   Examples per brief    10 (default)                         │
│   Brief experiment      off                                  │
│                                                              │
│   Type to edit, Ctrl+U to clear. A new id starts a new goal… │
│                                                              │
│   ↑↓ move · ←→ change · Enter start · Esc cancel             │
╰──────────────────────────────────────────────────────────────╯
```

↑↓ picks a row, ←→ (or Space) changes it, typing edits the goal id, Enter
starts. Starting under a different id than the one on screen switches the view
to the new goal. Goal flags on the command line (the same ones `goal:send`
takes: `--model`, `--max-attempts`, `--max-stalls`, `--max-tokens`,
`--reasoning-effort`, `--reasoning-max-tokens`, `--no-focus`, `--spec`,
`--examples N`, `--variant <name>`) become the form's starting values; a `--model` slug that isn't
in the list is added to it. `--start` skips the form and starts with the flags
as given (needs `--goal`). **Brief experiment** runs the goal as one
variant of the `brief` experiment (see Evals & experiments); the variant's
options override Focus, Go docs and Examples.

Every attempt runs on a fresh sandbox seeded with the goal's best code, so
goals don't share anything and can run side by side.

Starting a goal id that already ran starts a new run under the same id; the TUI
always shows the latest run of an id.

### Answering a review

When the loop parks, the live pane turns into a review pane with what you need
to write a useful note:

- **What still fails:** the best attempt's check report, the same one every
  attempt reads: failures by function, then the shortest failing examples.
- **What the stalled attempts tried:** each one's own `work_finish` summary
  and outcome.
- An editor, pre-filled with the previous note. A review **replaces** the note,
  so keep what still applies and add to it.

Enter sends `goal/review.submitted` with `continue` and your note; Alt+Enter
adds a new line; Ctrl+S sends `stop` (the loop scores the holdout and
finishes). A review sent while attempts are still running isn't lost: it goes
into the goal's inbox, and the next attempt's brief carries the note. Good notes state a rule the model keeps missing ("a prerelease
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

The worker publishes to that channel from the goal and from each attempt's
`onTurn` (`src/lib/live.ts`). Each publish is its own memoized step that
swallows errors, so a replay never re-sends a message and a Realtime problem
can never fail or retry a goal. Quitting the TUI (`q` or Ctrl+C) only closes the
subscription; the run doesn't know or care whether anyone is watching.

## Running on Inngest Cloud

The deployed shape is a long-lived [Connect](https://www.inngest.com/docs/setup/connect)
worker (`src/worker.ts`): it dials out to Inngest over a WebSocket, so it needs
no public URL. Attempts and the grader run on Inngest Sandboxes, as on the dev
server.

1. Your Inngest account needs Sandbox access, and the `semver-coder:v1` image
   (`images/coder/`) in your workspace.
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
| `MODEL_PROVIDERS` | unset | OpenRouter providers to use, comma-separated, tried in order, with no fallback to others. Unset: the fastest provider that supports every parameter |
| `MODEL_BASE_URL` | OpenRouter | any OpenAI-compatible endpoint |
| `MODEL_TIMEOUT_MS` | 180000 | per-call timeout, raised for big turn budgets; a timed-out turn is retried by its step |
| `INNGEST_DEV` | (unset = Cloud) | `1` for the dev server |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | | Cloud only |

Per goal, `goal/started` also accepts `maxTurnsPerAttempt` (default 8),
`focus` (default `true`; `--no-focus` on `goal:send` / `goal:watch`), `spec`
(default `false`; `--spec`: Go's documentation in the brief), `examplesPerBrief`
(default 10; `--examples N`, up to 50: with a focus, N of that function's own
failing cases), and
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

## Trying another model

Any model on OpenRouter should run without per-model flags:

- **Checked at goal start.** The `settings` step reads the model's
  OpenRouter listing. A slug that doesn't exist, or a model no provider serves
  with tools and `tool_choice`, fails the goal at once with a reason (the TUI
  shows it) instead of 20 failed attempts. `reasoning` is only sent when some
  tool-capable provider takes it, and the turn budget stays under the largest
  `max_completion_tokens`.
- **Reasoning that won't stop.** Reasoning controls come in three kinds: a
  token budget that's honoured, an effort level that's a hint, and on/off
  only. The listing doesn't say which (mistral-large-4-0 ignored a 1,500-token
  budget and effort `low`, and thought past 18k tokens). So when a turn comes
  back cut off before its tool call, the model (`src/models/openrouter.ts`)
  asks again within the same call, one rung up: first a nudge ("you ran out of
  room while thinking; act now"), then a doubled turn budget (up to the
  model's limit, at most 32k, with the call timeout scaled to match), then
  reasoning off, which every kind honours. The loop only ever sees the reply
  that acted. The TUI marks those turns (`budget 8.0k`, `reasoning off`).
- **Learned once.** When an attempt's replies needed a higher rung, later
  attempts of the goal start on it.

`--max-tokens` and `--reasoning-max-tokens` still set the starting point.

## Scripts

| Command | |
|---|---|
| `pnpm goal:watch -- --goal <id> …` | the TUI (see above) |
| `pnpm goal:send -- --goal <id> …` | send `goal/started` without the TUI (same flags) |
| `pnpm eval -- …` / `pnpm eval:report -- --batch <id>` | run and summarize an eval set (see Evals & experiments) |
| `pnpm inngest` / `pnpm dev` | dev server / worker for local runs |
| `pnpm start:worker` | the Connect worker (what Cloud runs) |
| `pnpm check:selftest` / `pnpm check:harness` | grader selftests / the ladder, loop state and brief |
| `pnpm check -- --file <path> --set train` | run the check by hand on a file (default: the stub) |
| `python3 scripts/trace-dump.py <since ISO time>` | per-attempt scores, costs, turns and tool calls from the dev server |
| `pnpm typecheck` | `tsc --noEmit` |

Answering a review without the TUI:

```sh
curl -s -X POST localhost:8288/e/test -H 'content-type: application/json' \
  -d '{"name":"goal/review.submitted","data":{"goalId":"my-goal","action":"continue","note":"..."}}'
```

## Seeing what a turn did

Every model call and every tool call is a row in the coder run's trace, with
its input and output, and every sandbox command is a row under it. The agents
also record model time, tokens, tool calls and tool errors as scores on every
run.

- **`inngest.ai` metadata** (model, input/output tokens, latency, cost) comes
  from OpenTelemetry: the worker starts with `--import @inngest/otel/node`
  (in `pnpm dev`, `pnpm start`, `pnpm start:worker` and the Dockerfile), which
  instruments the OpenAI SDK so each call emits `gen_ai.*` spans. The
  instrumentation patches `openai` `>=4 <7` only, so `openai` is pinned to v6.
- **What the reply said** beyond its text (OpenRouter's provider, finish
  reason, reasoning tokens, the ladder rung) reaches `onTurn` and the TUI's
  turn line.

A failed call is retried by its step: timeouts, 408, 409, 429 and 5xx. Any
other 4xx fails the attempt at once (the request itself is wrong).

## Evals & experiments

The eval case is the full semver goal, repeated. What varies is the brief, as
an Inngest **Experiment** named `brief` with four variants (written out in
`src/agents/goal.ts`):

| Variant | Brief |
|---|---|
| `control` | today's defaults |
| `spec` | Go's documentation included (`--spec`) |
| `examples` | 30 examples per brief (`--examples 30`) |
| `no_focus` | the whole report, not one function (`--no-focus`) |

A `goal/started` with a `variant` runs the whole goal inside
`group.experiment("brief", ...)` with that variant fixed, so each variant gets
the same number of runs and every score the goal writes counts toward it.
Without a `variant` nothing changes.

Scores (the goal's `score({...})`, one step per batch):

- **Per attempt:** `check.fail_rate`, `attempt.pass_rate`,
  `attempt.delta_failed`, `attempt.kept`, `attempt.turns`, `attempt.idle_turns`,
  `attempt.cost_usd`.
- **Final** (run-scoped, attributed to the experiment):
  `train.pass_rate`, `holdout.pass_rate`, `generalization_gap`, `solved`,
  `attempts`, `kept_attempts`, `best_at_attempt`, `cost_usd`, `tokens_total`, and
  `fn.<Name>.pass_rate` per function (train, the only per-function data the
  check produces).

```sh
pnpm eval -- [--set brief-v1] [--repeats N] [--max-attempts N] [--variants control,spec] [--sequential] [--timeout-min N]
pnpm eval:report -- --batch eval-brief-v1-<yyyymmdd-hhmmss>
```

`pnpm eval` reads `evals/<set>.json`, sends one run per variant and repeat
(goal id `eval-<set>-<yyyymmdd-hhmmss>-<variant>-r<k>`, `maxStalls = maxAttempts + 1`
so it never parks for a review), and prints the batch id. `pnpm eval:report`
prints one row per variant: n, mean train and holdout pass rate, gap, solved,
mean attempts and cost.

The runs go in parallel. `--sequential` sends a run, waits for its
`goal/finished` (up to `--timeout-min`, default 10 per attempt), then sends the next.

## Limits and gotchas

- **Step limit.** Inngest caps a run at 1,000 steps, which caps a goal at 70
  attempts (an attempt is about 12 steps of the goal's run; the attempt's own
  turns are steps of its coder run). Chaining runs past that isn't built.
- **Outages longer than the retries.** State always survives a worker outage,
  but if the worker is gone longer than the retry window of the run that has
  to go next, the run fails. A failed attempt counts as a stall.
- **Don't change step ids under a run you care about.** `tsx watch` hot-reloads
  the worker; renaming a step's display `name` is fine, changing its `id` isn't.

`BUILD_LOG.md` has the full history of building and running it.
