// Rebuilds a goal's past from the REST events API, for `pnpm goal:watch`.
// Realtime has no history, so the watcher starts from this and then applies
// live messages on top (src/inngest/channel.ts).
import type { AttemptOutcome, ScoredMessage } from "../inngest/channel.js";

type ApiEvent = { name: string; received_at: string; data: Record<string, any> };

export type GoalHistory = {
  startedAt?: string;
  model?: string;
  maxAttempts?: number;
  maxStalls?: number;
  rows: ScoredMessage[];
  // The latest review note sent for this goal (the next review must resend it).
  lastNote?: string;
  // The best attempt's check report (what still fails), for the review pane.
  bestReport?: string;
  // Set when the last scored attempt hit the stall limit and no review came after.
  waiting: boolean;
  finished?: {
    best: { score: number; failed: number; total: number };
    holdout: { score: number; failed: number; total: number; pass: boolean };
    attempts: number;
    costUsd: number;
  };
};

// Same reading as the SDK: INNGEST_DEV=0 / false means Cloud, a URL is a dev server.
export function apiTarget(): { base: string; headers: Record<string, string> } {
  const dev = (process.env.INNGEST_DEV ?? "").trim();
  if (dev !== "" && dev !== "0" && dev.toLowerCase() !== "false") {
    return { base: dev.startsWith("http") ? dev.replace(/\/$/, "") : "http://localhost:8288", headers: {} };
  }
  const key = process.env.INNGEST_SIGNING_KEY;
  if (!key) throw new Error("set INNGEST_SIGNING_KEY (Cloud) or INNGEST_DEV=1 (dev server)");
  return { base: process.env.INNGEST_API_BASE_URL ?? "https://api.inngest.com", headers: { Authorization: `Bearer ${key}` } };
}

// How far back to look for a goal's start. Without an explicit received_after
// the events API only returns recent events (about the last hour), so an
// older goal's goal/started went missing. Matches the review wait (3d) + slack.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Newest first, paging back with received_before until `after` (or `maxPages`).
async function fetchEvents(name: string, after = new Date(Date.now() - LOOKBACK_MS).toISOString(), maxPages = 10): Promise<ApiEvent[]> {
  const { base, headers } = apiTarget();
  const out: ApiEvent[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ name, limit: "100" });
    q.set("received_after", after);
    if (before) q.set("received_before", before);
    const res = await fetch(`${base}/v1/events?${q}`, { headers });
    if (!res.ok) throw new Error(`GET /v1/events ${name}: ${res.status}`);
    const data = ((await res.json()) as { data?: ApiEvent[] }).data ?? [];
    out.push(...data);
    if (data.length < 100) break;
    before = data[data.length - 1]!.received_at;
  }
  return out;
}

const byTime = (a: ApiEvent, b: ApiEvent) => a.received_at.localeCompare(b.received_at);

export async function loadGoalHistory(goalId: string): Promise<GoalHistory> {
  const forGoal = (es: ApiEvent[]) => es.filter((e) => e.data?.goalId === goalId).sort(byTime);

  // The latest goal/started for this id bounds everything else, so an earlier
  // run that reused the id doesn't leak in.
  const started = forGoal(await fetchEvents("goal/started", undefined, 3)).at(-1);
  const after = started?.received_at;
  const [scored, reviews, finished] = await Promise.all([
    fetchEvents("goal/attempt.scored", after).then(forGoal),
    fetchEvents("goal/review.submitted", after).then(forGoal),
    fetchEvents("goal/finished", after, 1).then(forGoal),
  ]);

  const maxStalls: number | undefined = started?.data.maxStalls;
  const stallLimit = maxStalls ?? 5;

  // One row per attempt (a re-sent event for the same i keeps the latest).
  const latest = new Map<number, ApiEvent>();
  for (const e of scored) latest.set(e.data.i, e);
  const ordered = [...latest.values()].sort((a, b) => a.data.i - b.data.i);

  // The scored event predates the keep/revert decision, so replay it here.
  // The baseline isn't in any event; the stub fails every case, so start at 1.
  let best = 1;
  let stalls = 0;
  let waiting = false;
  let lastNote: string | undefined;
  let bestReport: string | undefined;
  let r = 0; // next review to consume
  const rows: ScoredMessage[] = [];
  for (const e of ordered) {
    const d = e.data;
    const outcome: AttemptOutcome = !d.changed
      ? d.turns === 0 && d.costUsd === 0
        ? "failed"
        : "unchanged"
      : d.score < best
        ? "kept"
        : "reverted";
    if (outcome === "kept") {
      best = d.score;
      stalls = 0;
      if (d.report) bestReport = d.report;
    } else stalls++;
    rows.push({
      type: "attempt.scored",
      i: d.i,
      score: d.score,
      failed: d.failed,
      total: d.total,
      changed: d.changed,
      turns: d.turns,
      idleTurns: d.idleTurns,
      costUsd: d.costUsd,
      outcome,
      bestScore: best,
      stalls,
      summary: d.summary,
    });
    if (stalls >= stallLimit) {
      const review = reviews.slice(r).find((x) => x.received_at > e.received_at);
      if (review) {
        r = reviews.indexOf(review) + 1;
        if (review.data.note) lastNote = review.data.note;
        stalls = 0;
        waiting = false;
      } else waiting = true;
    }
  }
  const lastReviewNote = reviews.filter((x) => x.data.note).at(-1)?.data.note;

  const f = finished.at(-1)?.data;
  return {
    startedAt: after,
    model: started?.data.model,
    maxAttempts: started?.data.maxAttempts,
    maxStalls,
    rows,
    lastNote: lastNote ?? lastReviewNote,
    bestReport,
    waiting: waiting && !f,
    finished: f && { best: f.best, holdout: f.holdout, attempts: f.attempts, costUsd: f.costUsd },
  };
}
