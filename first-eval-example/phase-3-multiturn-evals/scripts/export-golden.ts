// Exports the `golden` DuckDB view (src/db.ts) to an OpenAI-style chat SFT
// JSONL file — one `{"messages": [...]}` line per golden sample, transcript
// plus the captured reply as the final assistant turn. Run after some traffic
// has flowed through the worker (see `bun run populate`):
//
//   bun run export
//
// Deliberately does NOT import `db()` from src/db.ts — that function runs the
// CREATE TABLE/VIEW statements and needs a read-write handle, and DuckDB only
// allows one read-write process on a database file at a time. This script
// only needs to read, so it opens its own read-only connection instead of
// contending with the worker (or any other writer) for that lock.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { DB_PATH } from "../src/db";

const GOLDEN_PATH = new URL("../data/golden.jsonl", import.meta.url).pathname;

async function main(): Promise<void> {
  let instance;
  try {
    instance = await DuckDBInstance.create(DB_PATH, { access_mode: "READ_ONLY" });
  } catch (err) {
    // DuckDB allows exactly one read-write process on a file at a time; a
    // read-only open fails while the worker (capture-dataset's writer) holds
    // it open. Give a clear instruction instead of a raw DuckDB IO error.
    console.error(`Could not open ${DB_PATH} read-only: ${(err as Error).message}`);
    if (!existsSync(DB_PATH)) {
      console.error(
        "The database file doesn't exist yet — start the worker (bun run dev) and send some traffic through it first.",
      );
    } else {
      console.error(
        "Stop the worker first (bun run dev) — DuckDB allows only one read-write process on a database file at a time.",
      );
    }
    process.exit(1);
  }

  const connection = await instance.connect();

  const goldenRows = (await connection.runAndReadAll("SELECT * FROM golden ORDER BY created_at")).getRowObjectsJson();

  const systemPrompt = process.env.EXPORT_SYSTEM_PROMPT;
  const lines = goldenRows.map((row) => {
    // `conversation` is a JSON column; getRowObjectsJson() may hand it back
    // already parsed or still as a JSON string depending on how DuckDB's
    // JSON type round-trips through that call — handle both defensively
    // rather than assuming one or the other.
    const conversation = typeof row.conversation === "string" ? JSON.parse(row.conversation) : row.conversation;
    const messages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...(conversation as Array<{ role: string; content: string }>),
      { role: "assistant", content: row.reply },
    ];
    return JSON.stringify({ messages });
  });

  // The `data/` dir normally already exists by the time export runs (db()
  // creates it on first worker startup), but this script never calls db(),
  // so make sure it's there before writing — e.g. a fresh clone where
  // someone runs `bun run export` against a DB file copied in from elsewhere.
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  await Bun.write(GOLDEN_PATH, lines.join("\n") + (lines.length ? "\n" : ""));

  await printSummary(connection, goldenRows);

  console.log(`\nWrote ${lines.length} golden sample(s) to ${GOLDEN_PATH}`);
}

// All counts below are routed through Number(...) or come from
// getRowObjectsJson() (already JSON-safe) before being used in arithmetic or
// template strings — DuckDB's raw value getters return BigInt for count(*),
// which throws if it ever hits JSON.stringify or silently coerces oddly in
// template literals.
async function printSummary(connection: DuckDBConnection, goldenRows: Record<string, unknown>[]): Promise<void> {
  // count(*) comes back through getRowObjectsJson() as a numeric *string*
  // (DuckDB's BigInt result, coerced to a JSON-safe string) rather than a
  // JS number — confirmed empirically against a real query, not assumed.
  // Number(...) here is load-bearing, not defensive: without it `n` would be
  // a string and every arithmetic use below would depend on implicit JS
  // coercion instead of an explicit, checked conversion.
  const [{ n: totalSamples }] = (await connection.runAndReadAll("SELECT count(*) n FROM samples")).getRowObjectsJson() as [
    { n: string | number },
  ];
  const [{ n: totalScores }] = (await connection.runAndReadAll("SELECT count(*) n FROM scores")).getRowObjectsJson() as [
    { n: string | number },
  ];
  const [{ n: explicitThumbsDown }] = (
    await connection.runAndReadAll("SELECT count(*) n FROM scores WHERE name = 'thumbs-up' AND value = 0")
  ).getRowObjectsJson() as [{ n: string | number }];
  const [{ n: validJsonCount }] = (
    await connection.runAndReadAll("SELECT count(*) n FROM scores WHERE name = 'valid-json' AND value = 1")
  ).getRowObjectsJson() as [{ n: string | number }];
  const [{ n: invalidJsonCount }] = (
    await connection.runAndReadAll("SELECT count(*) n FROM scores WHERE name = 'valid-json' AND value = 0")
  ).getRowObjectsJson() as [{ n: string | number }];

  const totalSamplesN = Number(totalSamples);
  const totalScoresN = Number(totalScores);
  const explicitThumbsDownN = Number(explicitThumbsDown);
  const validJsonCountN = Number(validJsonCount);
  const invalidJsonCountN = Number(invalidJsonCount);
  const validJsonRate = totalSamplesN > 0 ? validJsonCountN / totalSamplesN : 0;

  const goldenCount = goldenRows.length;
  const goldenRate = totalSamplesN > 0 ? goldenCount / totalSamplesN : 0;

  const byVariant = new Map<string, number>();
  let viaThumbs = 0;
  let viaJudge = 0;
  for (const row of goldenRows) {
    const variant = typeof row.variant === "string" ? row.variant : "(none)";
    byVariant.set(variant, (byVariant.get(variant) ?? 0) + 1);
    if (row.thumbs_up === 1) viaThumbs++;
    else viaJudge++;
  }

  // Rough quality_avg distribution over ALL samples (not just golden), to
  // sanity-check the 0.8 threshold — LEFT JOIN so samples with no judge
  // scores yet still show up, bucketed separately rather than dropped.
  const judgeRows = (
    await connection.runAndReadAll(`
      WITH pivoted AS (
        SELECT run_id,
          (max(CASE WHEN name='reply-quality' THEN value END)
           + max(CASE WHEN name='context-awareness' THEN value END)) / 2.0 AS quality_avg
        FROM scores GROUP BY run_id
      )
      SELECT s.run_id, p.quality_avg FROM samples s LEFT JOIN pivoted p ON p.run_id = s.run_id
    `)
  ).getRowObjectsJson();

  const buckets = { "< 0.5": 0, "0.5 - 0.8": 0, ">= 0.8": 0, "no judge score yet": 0 };
  for (const row of judgeRows) {
    const qualityAvg = row.quality_avg as number | null;
    if (qualityAvg === null || qualityAvg === undefined) buckets["no judge score yet"]++;
    else if (qualityAvg < 0.5) buckets["< 0.5"]++;
    else if (qualityAvg < 0.8) buckets["0.5 - 0.8"]++;
    else buckets[">= 0.8"]++;
  }

  console.log("--- export-golden summary ---");
  console.log(
    `valid-JSON rate:    ${(validJsonRate * 100).toFixed(1)}% (${validJsonCountN}/${totalSamplesN}) — headline fine-tune metric`,
  );
  console.log(`total samples:      ${totalSamplesN}`);
  console.log(`total scores:       ${totalScoresN}`);
  console.log(`golden samples:     ${goldenCount} (${(goldenRate * 100).toFixed(1)}% of total samples)`);
  console.log(`  via thumbs_up=1:       ${viaThumbs}`);
  console.log(`  via judge path:        ${viaJudge}`);
  console.log(`excluded (thumbs_up=0):    ${explicitThumbsDownN}`);
  console.log(`excluded (invalid JSON):   ${invalidJsonCountN}`);
  console.log("golden by variant:");
  for (const [variant, count] of byVariant) {
    console.log(`  ${variant}: ${count}`);
  }
  console.log("quality_avg distribution (all samples):");
  for (const [bucket, count] of Object.entries(buckets)) {
    console.log(`  ${bucket}: ${count}`);
  }
}

main();
