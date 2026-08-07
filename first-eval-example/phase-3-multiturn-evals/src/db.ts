import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";

export const DB_PATH = process.env.EVALS_DB_PATH ?? new URL("../data/evals.duckdb", import.meta.url).pathname;

mkdirSync(dirname(DB_PATH), { recursive: true });

// Lazy singleton: the worker (via capture.ts) and one-off scripts (export,
// ad-hoc `bun -e` inspection) all import this module, but DuckDB only allows
// one read-write handle on a file at a time — fromCache() plus this
// module-level promise means every caller in this process shares the same
// connection instead of racing to open the file twice.
let _connection: Promise<DuckDBConnection> | undefined;

export function db(): Promise<DuckDBConnection> {
  if (!_connection) {
    _connection = open();
  }
  return _connection;
}

async function open(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.fromCache(DB_PATH);
  const connection = await instance.connect();

  // samples and scores have no foreign key between them on purpose: scores
  // for a run_id routinely arrive (and get upserted) before that run_id's own
  // row exists in samples, since the judge and feedback scorers finish on
  // completely different timelines than the inline capture that writes the
  // sample (feedback in particular can lag up to a day behind, per its
  // waitForEvent timeout). Requiring the sample row first would mean losing
  // scores whenever a scorer just happens to beat the sample write.
  await connection.run(`
    CREATE TABLE IF NOT EXISTS samples (
      run_id TEXT PRIMARY KEY,
      conversation JSON NOT NULL,
      reply TEXT NOT NULL,
      variant TEXT,
      model TEXT,
      latency_ms INTEGER,
      message_id TEXT,
      conversation_id TEXT,
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  await connection.run(`
    CREATE TABLE IF NOT EXISTS scores (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value DOUBLE NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (run_id, name)
    )
  `);

  // The golden-sample criteria, expressed once here rather than duplicated
  // across every consumer. `valid_json = 1` is checked first and is
  // unconditional: any reply that doesn't parse as strict triage JSON is
  // excluded no matter what else is true — this is the fine-tune demo's core
  // signal, so sloppy output never becomes a golden sample regardless of
  // thumbs or judge scores. Past that gate, an explicit thumbs_up = 0 always
  // excludes a run — it fails the `thumbs_up = 1` branch, and the OR's second
  // branch requires `thumbs_up IS NULL`, so an explicit down-vote fails both.
  // `sentiment_correct` is pivoted/exposed for visibility but intentionally
  // NOT part of the WHERE clause — sentiment judgment is more subjective than
  // category/urgency, so it's recorded but doesn't gate. A run missing any of
  // the required judge scores gets a NULL somewhere in the pivot: missing
  // category_correct/urgency_correct fails their own `= 1` check directly,
  // and missing reply-quality or context-awareness makes quality_avg NULL
  // (every max() in the pivot is NULL, and NULL/2.0 is NULL), which fails
  // `>= 0.8` — so partial judge data excludes rather than silently passing.
  // The tables capture everything unconditionally; this view is the only
  // place the threshold is applied, so it can move later without re-scoring
  // anything.
  await connection.run(`
    CREATE OR REPLACE VIEW golden AS
    WITH pivoted AS (
      SELECT
        run_id,
        max(CASE WHEN name = 'valid-json' THEN value END) AS valid_json,
        max(CASE WHEN name = 'thumbs-up' THEN value END) AS thumbs_up,
        max(CASE WHEN name = 'category-correct' THEN value END) AS category_correct,
        max(CASE WHEN name = 'urgency-correct' THEN value END) AS urgency_correct,
        max(CASE WHEN name = 'sentiment-correct' THEN value END) AS sentiment_correct,
        (
          max(CASE WHEN name = 'reply-quality' THEN value END)
          + max(CASE WHEN name = 'context-awareness' THEN value END)
        ) / 2.0 AS quality_avg
      FROM scores
      GROUP BY run_id
    )
    SELECT
      s.*,
      p.thumbs_up,
      p.valid_json,
      p.category_correct,
      p.urgency_correct,
      p.sentiment_correct,
      p.quality_avg
    FROM samples s
    JOIN pivoted p ON p.run_id = s.run_id
    WHERE p.valid_json = 1
      AND (p.thumbs_up = 1
           OR (p.thumbs_up IS NULL AND p.category_correct = 1 AND p.urgency_correct = 1 AND p.quality_avg >= 0.8))
  `);

  return connection;
}

export type SampleInput = {
  runId: string;
  conversation: unknown;
  reply: string;
  variant?: string;
  model?: string;
  latencyMs?: number;
  messageId?: string;
  conversationId?: string;
};

export async function upsertSample(input: SampleInput): Promise<void> {
  const connection = await db();
  await connection.run(
    `INSERT INTO samples (run_id, conversation, reply, variant, model, latency_ms, message_id, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       conversation = excluded.conversation,
       reply = excluded.reply,
       variant = excluded.variant,
       model = excluded.model,
       latency_ms = excluded.latency_ms,
       message_id = excluded.message_id,
       conversation_id = excluded.conversation_id`,
    [
      input.runId,
      JSON.stringify(input.conversation),
      input.reply,
      input.variant ?? null,
      input.model ?? null,
      input.latencyMs ?? null,
      input.messageId ?? null,
      input.conversationId ?? null,
    ] satisfies DuckDBValue[],
  );
}

export type ScoreInput = {
  runId: string;
  name: string;
  value: number;
  source: string;
};

export async function upsertScore(input: ScoreInput): Promise<void> {
  const connection = await db();
  await connection.run(
    `INSERT INTO scores (run_id, name, value, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (run_id, name) DO UPDATE SET
       value = excluded.value,
       source = excluded.source`,
    [input.runId, input.name, input.value, input.source] satisfies DuckDBValue[],
  );
}
