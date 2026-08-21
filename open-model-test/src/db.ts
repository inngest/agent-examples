import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

// SQLite results store — one row per (model, task, sample), exactly the spec
// §9 data model plus the failure-gallery columns (code, stdout, stderr, error).
// The DB at data/results.db is the source of truth; aggregate-run and the
// export script copy rows out to results/<run_id>/ as committed JSON.

export const DB_PATH =
  process.env.RESULTS_DB_PATH ?? new URL("../data/results.db", import.meta.url).pathname;

mkdirSync(dirname(DB_PATH), { recursive: true });

// Lazy singleton: the worker (via the Inngest functions) and one-off scripts
// all import this module and share one connection. WAL keeps concurrent
// readers (scripts) unblocked while the worker writes.
let _db: Database | undefined;

export function db(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec("PRAGMA journal_mode = WAL;");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        expected_samples INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        config_json TEXT NOT NULL,
        harness_commit TEXT,
        git_dirty INTEGER,
        suite_hash TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS completions (
        run_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sample INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, model_id, task_id, sample)
      )
    `);
    // compiled/tests_passed/static_* are NULL when the sandbox hasn't run
    // (stubbed sandbox) or the generation itself failed. Agentic columns:
    // agent_turns = attempts used, turns_to_green = the turn that went green
    // (NULL = never green within budget), turns_trace = per-turn JSON,
    // artifacts_ref = path under results/<run_id>/artifacts/.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        run_id TEXT NOT NULL,
        model TEXT NOT NULL,
        model_params TEXT NOT NULL,
        task_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'coding',
        language TEXT NOT NULL,
        sample INTEGER NOT NULL,
        seed INTEGER,
        compiled INTEGER,
        tests_passed INTEGER,
        tests_total INTEGER,
        static_pass INTEGER,
        static_issues INTEGER,
        turns_to_green INTEGER,
        max_agent_turns INTEGER NOT NULL DEFAULT 1,
        agent_turns INTEGER NOT NULL DEFAULT 1,
        turns_trace TEXT,
        artifacts_ref TEXT,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        ttft_ms INTEGER,
        tokens_per_sec REAL,
        latency_ms INTEGER,
        cost_usd REAL,
        judge_score REAL,
        code TEXT,
        stdout TEXT,
        stderr TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, model, task_id, sample)
      )
    `);
  }
  return _db;
}

export type RunRow = {
  run_id: string;
  expected_samples: number;
  status: string;
  config_json: string;
  harness_commit: string | null;
  git_dirty: number | null;
  suite_hash: string | null;
  created_at: string;
  completed_at: string | null;
};

export function createRun(
  runId: string,
  expectedSamples: number,
  configJson: string,
  meta: { harnessCommit: string | null; gitDirty: boolean; suiteHash: string },
): void {
  db()
    .query(
      `INSERT OR IGNORE INTO runs
         (run_id, expected_samples, status, config_json, harness_commit, git_dirty, suite_hash, created_at)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      expectedSamples,
      configJson,
      meta.harnessCommit,
      meta.gitDirty ? 1 : 0,
      meta.suiteHash,
      new Date().toISOString(),
    );
}

export function getRun(runId: string): RunRow | null {
  return db().query("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | null;
}

export function listRuns(): RunRow[] {
  return db().query("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRow[];
}

export function markRunStatus(runId: string, status: string): void {
  const completedAt = status === "completed" ? new Date().toISOString() : null;
  db()
    .query("UPDATE runs SET status = ?, completed_at = COALESCE(?, completed_at) WHERE run_id = ?")
    .run(status, completedAt, runId);
}

// Idempotent: INSERT OR IGNORE means a retried tally step can't double-count.
export function recordCompletion(runId: string, modelId: string, taskId: string, sample: number): void {
  db()
    .query(
      "INSERT OR IGNORE INTO completions (run_id, model_id, task_id, sample, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(runId, modelId, taskId, sample, new Date().toISOString());
}

export function completionCount(runId: string): number {
  const row = db().query("SELECT COUNT(*) AS n FROM completions WHERE run_id = ?").get(runId) as {
    n: number;
  };
  return row.n;
}

export type ResultRow = {
  run_id: string;
  model: string;
  model_params: string;
  task_id: string;
  tier: string;
  task_type: string;
  language: string;
  sample: number;
  seed: number | null;
  compiled: number | null;
  tests_passed: number | null;
  tests_total: number | null;
  static_pass: number | null;
  static_issues: number | null;
  turns_to_green: number | null;
  max_agent_turns: number;
  agent_turns: number;
  turns_trace: string | null;
  artifacts_ref: string | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  ttft_ms: number | null;
  tokens_per_sec: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  judge_score: number | null;
  code: string | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  created_at: string;
};

export type ResultInput = Omit<ResultRow, "created_at"> & { created_at?: string };

export function upsertResult(input: ResultInput): void {
  db()
    .query(
      `INSERT INTO results (
         run_id, model, model_params, task_id, tier, task_type, language, sample, seed,
         compiled, tests_passed, tests_total, static_pass, static_issues,
         turns_to_green, max_agent_turns, agent_turns, turns_trace, artifacts_ref,
         tokens_prompt, tokens_completion, ttft_ms, tokens_per_sec, latency_ms,
         cost_usd, judge_score, code, stdout, stderr, error, created_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT (run_id, model, task_id, sample) DO UPDATE SET
         model_params = excluded.model_params,
         tier = excluded.tier,
         task_type = excluded.task_type,
         language = excluded.language,
         seed = excluded.seed,
         compiled = excluded.compiled,
         tests_passed = excluded.tests_passed,
         tests_total = excluded.tests_total,
         static_pass = excluded.static_pass,
         static_issues = excluded.static_issues,
         turns_to_green = excluded.turns_to_green,
         max_agent_turns = excluded.max_agent_turns,
         agent_turns = excluded.agent_turns,
         turns_trace = excluded.turns_trace,
         artifacts_ref = excluded.artifacts_ref,
         tokens_prompt = excluded.tokens_prompt,
         tokens_completion = excluded.tokens_completion,
         ttft_ms = excluded.ttft_ms,
         tokens_per_sec = excluded.tokens_per_sec,
         latency_ms = excluded.latency_ms,
         cost_usd = excluded.cost_usd,
         judge_score = excluded.judge_score,
         code = excluded.code,
         stdout = excluded.stdout,
         stderr = excluded.stderr,
         error = excluded.error`,
    )
    .run(
      input.run_id,
      input.model,
      input.model_params,
      input.task_id,
      input.tier,
      input.task_type,
      input.language,
      input.sample,
      input.seed,
      input.compiled,
      input.tests_passed,
      input.tests_total,
      input.static_pass,
      input.static_issues,
      input.turns_to_green,
      input.max_agent_turns,
      input.agent_turns,
      input.turns_trace,
      input.artifacts_ref,
      input.tokens_prompt,
      input.tokens_completion,
      input.ttft_ms,
      input.tokens_per_sec,
      input.latency_ms,
      input.cost_usd,
      input.judge_score,
      input.code,
      input.stdout,
      input.stderr,
      input.error,
      input.created_at ?? new Date().toISOString(),
    );
}

export function getResults(runId: string): ResultRow[] {
  return db()
    .query("SELECT * FROM results WHERE run_id = ? ORDER BY model, task_id, sample")
    .all(runId) as ResultRow[];
}
