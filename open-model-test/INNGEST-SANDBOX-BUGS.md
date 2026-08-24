# Inngest Sandboxes beta — SDK/API bug log

Environment: Inngest cloud API (`api.inngest.com`), TypeScript SDK **4.18.1**
(latest as of 2026-08-24), sandbox beta image `default` (NixOS x86_64, kernel
6.18, node v26.5.0 / npm 11.17.0). Found during the open-model-test demo
migration (Phase A recon, `scripts/probe-sandbox.ts`,
`scripts/probe-go-bootstrap.ts`; S4 found post-run via
`src/inngest/probe-experiment.ts`).

---

## Bug S1 — exec result parse throws when a stream is empty

**Severity: blocks almost every exec.**

The server omits `stdout` / `stderr` fields from the exec response when a
stream is empty, but the client's `wireCommandResultSchema` marks both
**required**. Any command that leaves either stream empty (i.e. nearly every
real command — successful ones usually have empty stderr) throws:

```
Invalid sandbox exec result at stderr: Required
```

The command itself **runs to completion server-side**; only the response
parsing fails, so the caller sees an exception with no output and no exit
code, and can't distinguish "ran fine" from "never ran".

- Affects the direct client (`inngest.sandboxes` → `commands.run`) **and**
  the durable `step.sandbox` path — `durable.js` `executeSandboxOperation`
  funnels exec through the same direct facade and its parse.
- Repro: `inngest.sandboxes.get(id).commands.run({ command: ["/bin/sh","-c","echo hi"] })`
  → throws (empty stderr omitted).
- Raw wire (server omits empty stderr — this is the actual response shape):
  `POST /v2/sandboxes/:id/exec {"command":["/bin/sh","-c","echo hi"],"cwd":"/tmp"}`
  → `200 {"data":{"encoding":"base64","exitCode":0,"stdout":"aGkK"}}`
- Fix is either side: server always emits both fields, or client schema
  makes `stdout`/`stderr` optional and decodes missing as empty.

**Workaround (in use):** wrap every command so both streams are provably
non-empty, preserving the real exit code:

```sh
{ <cmd> ; } ; __rc=$?
printf '\n__OMT_STDOUT__%s\n' "$__rc"
printf '\n__OMT_STDERR__%s\n' "$__rc" >&2
exit "$__rc"
```

then strip the markers client-side.

## Bug S2 — files.upload throws after the upload succeeds

**Severity: misleads callers into retrying a completed write.**

`POST` file upload succeeds (200), but the client throws while parsing the
result because the server returns `bytesWritten` as a **string** while the
SDK schema expects a **number**:

```
Invalid sandbox file upload result at bytesWritten: Expected number, received string
```

Verified that the file content is fully written server-side despite the
throw: a subsequent `files.download` returns the exact uploaded bytes.

- Repro: `sbx.files.upload({ path: "/workspace/seed.txt", data: "seed-content-123" })`
  → throws; `sbx.files.download({ path: "/workspace/seed.txt" })` → `"seed-content-123"`.
- Fix is either side: server sends a JSON number, or client coerces.

**Workaround (in use):** catch the throw and treat it as success (optionally
verify by download). Dangerous for naive callers: an idempotent retry loop
that keys on exceptions will re-upload.

## Bug S3 — exec against a nonexistent cwd returns 400 `invalid_field_format`

**Severity: misleading error, poor first-run experience.**

`commands.run` with `cwd: "/workspace"` (which **does not exist in the
default image**) returns:

```
400 {"code":"invalid_field_format","message":"Invalid sandbox request"}
```

The request format is valid; the directory is missing. A `not_found` /
`invalid_request` with the offending field named (or auto-creating the cwd,
or documenting the image's directory layout) would save users a debugging
session. There is no documented default workspace directory in the beta
image — `/workspace` is a natural convention and absent.

**Workaround (in use):** `mkdir -p /workspace` before any cwd-scoped exec;
bootstrap commands run with `cwd: "/"`.

## Bug S4 — step.score() inside a variant callback never attributes to the experiment

**Severity: silently produces an empty Experiments dashboard.**

`group.experiment()` + `step.score()` called inside the selected variant
callback — the usage the docs' troubleshooting table prescribes for
in-callback scoring ("call step.score() inside the selected variant
callback") — writes the score value but **no experiment attribution**: the
Experiments dashboard shows the experiment with no variant data.

Root cause (SDK 4.18.1 `components/InngestScore.js`): `sendStepScore()` issues
only a `performOp(..., "inngest.score", "merge")` with `{runId, stepId}` — it
never sends experiment/variant fields. Only `inngest.score.experiment()`
(`sendScoreExperiment`) writes the additional `"inngest.experiment"` metadata
op `{name, variant}` that the experiment view joins on. Steps inside the
variant do carry experiment context in their op `opts` (visible in traces),
but scores don't.

- Repro: `src/inngest/probe-experiment.ts` — variant "a" of
  `model-faceoff` scores via `step.score()` (in-variant) and
  `inngest.score.experiment()` (explicit ref) side by side; only the explicit
  ref populates the experiment view.
- Fix is either side: `sendStepScore` includes the ambient
  `execution.experimentContext` in its op, or the docs stop prescribing
  in-callback `step.score()` for experiment attribution.

**Workaround (in use):** after the variant returns, re-emit every metric via
`inngest.score.experiment({ name, value, experiment: experimentRef })` inside
a `step.run` (`src/inngest/functions.ts` `attribute-experiment-scores`).
Historical runs can be backfilled cross-run with the same call plus `runId`
(`scripts/backfill-scores.ts` — 88/100 samples of run `2026-08-24-493f4f`
attributed; 12 early runs predate the ~711-event `/v1/events` listing window,
and no public API lists function runs by function/time, so their run IDs are
undiscoverable).

---

## Image notes (not bugs, but shape the harness)

- Image `default` = NixOS x86_64; **no `/etc/os-release`**, no `getent`, **no
  curl** (wget + node v26 present), runs as **root**, ~9.7 GB free on `/`.
- No Go toolchain (expected — Node/Python/Ruby image), no bun. Harness
  bootstraps Go 1.27.0 from the official tarball via wget (see
  `src/sandbox/inngest.ts` `sb-install-go`).
- `runningTimeout` is client-capped at **300 000 ms** (5 min). The harness's
  original `RUNNING_TIMEOUT_S = 900` would throw `SandboxValidationError` at
  create — fixed to 300s. Sessions spanning slow turns + model latency must
  fit inside 5 min per running sandbox or be re-created.

Bug log maintained in `INNGEST-SANDBOX-BUGS.md`; harness workarounds live in
`src/sandbox/inngest.ts` and `scripts/probe-*.ts`. Found by the
open-model-test benchmark migration (FINDINGS.md, Finding 22 in progress).
