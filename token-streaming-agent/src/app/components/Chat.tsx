"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "inngest/react";
import { Markdown } from "./Markdown";
import {
  chatChannel,
  type ChatMessage,
  type ContextUsage,
  type StatusMessage,
} from "../../inngest/channel";

// `input` carries the structured tool arguments (only on "called" lines) so the
// shared ToolDetail renderer can pull run_python's `code` out for a code block;
// `detail` stays the single-line string used for every other tool's inline view.
type ToolLine = {
  turn: number;
  kind: "called" | "result";
  name: string;
  detail: string;
  input?: unknown;
};

type TurnView = { turn: number; text: string; streaming: boolean };

// Client-side only — never sent over the wire. One entry per `status`
// message worth keeping once a run finishes: tool calls/results and
// intermediate turn texts (i.e. everything except the final turn's text,
// which is already the bubble's main content). Ordered by arrival.
type TraceItem =
  | { type: "tool.called"; name: string; input: unknown }
  | { type: "tool.result"; name: string; output: string }
  | { type: "turn.completed"; text: string };

// Rebuild the collapsible trace from the durable `newMessages` a completed run
// returns (assistant tool_calls + `role: "tool"` results + intermediate
// assistant texts). Realtime has no backfill, so a reply recovered via the
// catch-up poll — or a live run whose tool events were partly lost to a mid-run
// reconnect — would otherwise show no trace. These durable messages carry
// everything the trace needs, so we reconstruct it from them.
function traceFromMessages(messages: ChatMessage[]): TraceItem[] {
  const items: TraceItem[] = [];
  const nameByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      // Text precedes the turn's tool calls, matching the live status order.
      if (typeof m.content === "string" && m.content.length > 0) {
        items.push({ type: "turn.completed", text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        nameByCallId.set(tc.id, tc.function.name);
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        items.push({ type: "tool.called", name: tc.function.name, input });
      }
    } else if (m.role === "tool") {
      const output = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const name = (m.tool_call_id && nameByCallId.get(m.tool_call_id)) || "tool";
      items.push({ type: "tool.result", name, output });
    }
  }
  // Drop the final turn.completed — it's the bubble's own reply, not
  // intermediate context (mirrors the live fold's exclusion).
  const lastTurnCompleted = items.map((i) => i.type).lastIndexOf("turn.completed");
  return lastTurnCompleted === -1 ? items : items.filter((_, i) => i !== lastTurnCompleted);
}

// `content` stays `string` here (not ChatMessage's wider content type) so
// nothing about rendering `entry.content` in JSX has to change — every entry
// the client creates is display text. `trace` is the client-side-only tool
// activity for a finished turn. `apiMessages` is also client-side-only: the
// exact API messages (tool_use/tool_result blocks) that turn produced,
// expanded back into the wire payload on the next send (see `send()` below)
// so follow-up turns keep tool context instead of just this entry's text.
type TranscriptEntry = {
  role: "user" | "assistant";
  content: string;
  trace?: TraceItem[];
  apiMessages?: ChatMessage[];
  // The triggering event id of the run that produced this assistant turn
  // (returned by /api/chat). Sent back with a 👍/👎 so the deferred scorer can
  // attribute the rating to the exact run. `feedback` records the local
  // selection, persisted with the transcript so a rating survives reloads.
  eventId?: string;
  feedback?: "up" | "down";
};

// Which experiment variant/model answered this session (sticky per session).
// `model` (the raw slug) is optional because the catch-up path only recovers
// the variant name, which is all the label below needs.
type ModelInfo = { variant: string; model?: string };

// Derive the badge label from the raw model slug so any model works with no
// hardcoded names — show the last path segment for brevity (e.g.
// "claude-sonnet-5"), falling back to the experiment variant only until the
// slug is known. The full slug stays available via the badge's title tooltip.
function modelLabel(m: ModelInfo): string {
  if (m.model) return m.model.split("/").pop() ?? m.model;
  return m.variant;
}

const DEMO_PROMPT =
  "Build a full weather report on Tokyo, Oslo, and Nairobi. Fetch all three, then use Python to compute each city's average high, average low, and total rainfall. Then run a second Python pass comparing the first and last two weeks to see which cities are warming. Convert the single hottest reading to Fahrenheit, check the local time in each city, and finish with a ranked summary table.";

// Empty-state suggestion cards. Each is a deliberately multi-step prompt (see
// COPY.md) that names its steps, so even a terse model chains several durable
// steps — fetch, multiple sandboxed Python passes, conversions, time lookups —
// and the run view shows a tall stack of checkpoints.
const SUGGESTIONS: { title: string; prompt: string }[] = [
  { title: "Three-city weather report", prompt: DEMO_PROMPT },
  {
    title: "Pick a trip destination",
    prompt:
      "I'm choosing between Lisbon, Barcelona, and Athens. Fetch their weather, use Python to score each on warmth, dryness, and calm wind, then rerun the scoring with dryness weighted double and tell me whether the winner changes. Check the local time in each, and recommend one with a comparison table.",
  },
  {
    title: "Five-city showdown",
    prompt:
      "Compare Tokyo, London, New York, Sydney, and Cape Town. Fetch them all, use Python to find each city's hottest and wettest day, then run a separate Python analysis of how humidity relates to rainfall in each city. Convert every city's average high to Fahrenheit, and summarize the three most surprising findings.",
  },
];

// Inline SVG icons (stroke-based, 24px grid) so the UI needs no icon library.
// They inherit `currentColor`, so CSS drives their color per state.
const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  thumbUp:
    "M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z",
  thumbDown:
    "M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z",
  copy: "M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8ZM16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3",
  check: "M5 12.5 10 17.5 19 7",
  chevron: "M9 6l6 6-6 6",
  wrench:
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  alert: "M12 8v5M12 16.5v.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
} as const;

function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// The assistant's avatar / the app's logo mark: a four-point spark.
function Spark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2c.5 4.6 2.4 7.3 5.3 8.6 1.3.6 2.9.9 4.7 1.4-1.8.5-3.4.8-4.7 1.4-2.9 1.3-4.8 4-5.3 8.6-.5-4.6-2.4-7.3-5.3-8.6C5.4 12.8 3.8 12.5 2 12c1.8-.5 3.4-.8 4.7-1.4C9.6 9.3 11.5 6.6 12 2Z"
      />
    </svg>
  );
}

// Marks a run_python line: the model-written script ran in the isolated Monty
// interpreter (src/worker/sandbox), not on the worker's host.
function SandboxChip() {
  return (
    <span
      className="sandbox-chip"
      title="Runs in an isolated Python interpreter: no filesystem, network, or environment access"
    >
      <Icon name="shield" size={11} />
      Sandboxed
    </span>
  );
}

// Max composer height before the textarea scrolls internally (~8 lines).
const COMPOSER_MAX_HEIGHT = 200;

// localStorage persistence so a conversation survives reloads and Inngest
// timeouts: the URL carries `?session=<id>` and the transcript is stored
// under `chat:<id>`. localStorage never expires on its own, so every load
// prunes entries older than STORAGE_TTL_MS.
const STORAGE_PREFIX = "chat:";
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// How long a resumed subscription waits for any sign of the pending run
// before concluding it finished (or died) while the page was away. Only used
// for legacy stored sessions that predate `pendingEventId` (no id to catch up
// on); newer runs recover deterministically via the catch-up poll below.
const RESUME_GIVE_UP_MS = 30_000;
// Catch-up polling: Inngest Realtime doesn't replay, so alongside the live
// subscription we poll the run's status by event id (api/run-status) as a
// safety net. Whichever delivers the finished reply first — realtime or a
// poll — commits it (guarded so it happens at most once). This makes a dropped
// connection or a mid-run reload recover the reply instead of losing it.
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 60; // ~2 minutes

type StoredSession = {
  savedAt: number;
  transcript: TranscriptEntry[];
  contextUsage: ContextUsage | null;
  // Set while a run is in flight so a reload can re-subscribe and pick the
  // stream back up; cleared when the run completes or fails.
  pendingRun: boolean;
  // The in-flight run's triggering event id, persisted so a reload can recover
  // the finished reply via the catch-up poll (api/run-status) even if the
  // realtime `run.completed` was missed. Absent on sessions saved before this
  // field existed — those fall back to the realtime-only resume valve.
  pendingEventId?: string;
  // The model this session is bucketed to (sticky), persisted so the badge
  // shows immediately on reload rather than only after the next run starts.
  currentModel?: ModelInfo;
};

function loadSession(sessionId: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

function saveSession(sessionId: string, session: Omit<StoredSession, "savedAt">) {
  try {
    localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify({ savedAt: Date.now(), ...session }));
  } catch {
    // Quota exceeded or storage disabled — persistence is best-effort.
  }
}

// Drop chats older than the TTL. Runs once per page load, across all stored
// sessions (not just the current one), so abandoned conversations don't
// accumulate forever.
function pruneStaleSessions() {
  try {
    const cutoff = Date.now() - STORAGE_TTL_MS;
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const { savedAt } = JSON.parse(localStorage.getItem(key) ?? "{}") as { savedAt?: number };
        if (!savedAt || savedAt < cutoff) localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key); // unparseable entry — discard
      }
    }
  } catch {
    // Storage disabled — nothing to prune.
  }
}

// Compact token count for the meter label: 137 → "137", 3400 → "3.4k",
// 200000 → "200k".
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

function ContextMeter({ usage }: { usage: ContextUsage }) {
  const used = usage.inputTokens + usage.outputTokens;
  // Reserve the per-response output cap (`maxTokens`) from the window: the bar
  // measures against the *usable* context, so it fills as the conversation
  // approaches the point where there's no longer room for a full response.
  // `?? 0` guards a pre-maxTokens turn.completed (denominator falls back to the
  // full window). Math.max keeps the denominator positive if maxTokens is
  // misconfigured larger than the window.
  const reserved = usage.maxTokens ?? 0;
  const usable = Math.max(1, usage.contextWindow - reserved);
  const fraction = Math.min(1, used / usable);
  // The fill escalates from accent to danger as the window fills; the number
  // in the label carries the same information, so color is never the only
  // signal.
  const high = fraction > 0.8;
  return (
    <div
      className="context-meter"
      title={`${used.toLocaleString()} of ${usable.toLocaleString()} usable tokens (${reserved.toLocaleString()} reserved for output)`}
    >
      <span className="context-meter-label">
        {formatTokens(used)} / {formatTokens(usable)}
      </span>
      <div className={`context-meter-track${high ? " high" : ""}`}>
        <div className="context-meter-fill" style={{ width: `${(fraction * 100).toFixed(2)}%` }} />
      </div>
    </div>
  );
}

// Clip a string shown in the trace so a large tool payload (e.g. the multi-city
// weather JSON, or a big run_python stdout) can't bloat the DOM. The full value
// still lives in the transcript/history; only this diagnostic view is clipped.
function clip(s: string, max = 2000): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more chars)` : s;
}

// Pull run_python's arguments out of its (untyped) tool input for the code view.
function extractPython(input: unknown): { code: string; cities: string[] } {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const code = typeof obj.code === "string" ? obj.code : "";
  const cities = Array.isArray(obj.cities) ? obj.cities.map(String) : [];
  return { code, cities };
}

// Render a run_python result envelope ({ ok, stdout, stderr, result, error })
// as readable blocks: stdout/result in a code block, error/stderr tinted. Falls
// back to the raw string if it isn't the expected JSON (e.g. an older run).
// Memoized: this renders once per tool result and must NOT re-render on every
// ~40ms token batch during a later answer stream (the live fold re-runs per
// batch and would otherwise re-parse the JSON + recreate the <pre> DOM ~25x/s,
// which is the monty-specific OOM/tab-crash path). Props are referentially
// stable across fold passes, so default shallow compare skips re-render.
const PythonResultView = memo(function PythonResultView({ output }: { output: string }) {
  let parsed: { stdout?: string; stderr?: string; result?: string; error?: string } | null = null;
  try {
    const v = JSON.parse(output);
    parsed = v && typeof v === "object" ? v : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return <code>{clip(output)}</code>;
  const { stdout, result, stderr, error } = parsed;
  const problem = error || stderr;
  return (
    <div className="tool-python-out">
      {stdout ? (
        <pre className="md-pre tool-pre">
          <code>{clip(stdout)}</code>
        </pre>
      ) : null}
      {result ? (
        <pre className="md-pre tool-pre">
          <code>{clip(result)}</code>
        </pre>
      ) : null}
      {problem ? (
        <pre className="md-pre tool-pre tool-pre-error">
          <code>{clip(problem)}</code>
        </pre>
      ) : null}
      {!stdout && !result && !problem ? <code>(no output)</code> : null}
    </div>
  );
});

// Shared renderer for one trace/tool line's content, used by both the persisted
// TraceDetails and the live in-flight list. run_python gets multi-line code and
// output as proper code blocks; every other tool keeps the compact inline view.
// Memoized for the same reason as PythonResultView — a tool line belongs to an
// earlier turn and its props are stable once the result arrives, so it must not
// re-render (and re-stringify/re-parse) on every token batch of a later turn.
const ToolDetail = memo(function ToolDetail({
  name,
  kind,
  input,
  output,
}: {
  name: string;
  kind: "called" | "result";
  input?: unknown;
  output?: string;
}) {
  const label = <span className="tool-name">{name}</span>;
  if (name === "run_python") {
    if (kind === "called") {
      const { code, cities } = extractPython(input);
      return (
        <>
          {label} <SandboxChip /> ran{cities.length ? ` on ${cities.join(", ")}` : ""}:
          <pre className="md-pre tool-pre">
            <code>{clip(code, 4000)}</code>
          </pre>
        </>
      );
    }
    return (
      <>
        {label} output:
        <PythonResultView output={output ?? ""} />
      </>
    );
  }
  if (kind === "called") {
    return (
      <>
        {label} called with <code>{clip(JSON.stringify(input))}</code>
      </>
    );
  }
  return (
    <>
      {label} returned <code>{clip(output ?? "")}</code>
    </>
  );
});

function TraceDetails({ trace }: { trace: TraceItem[] }) {
  const toolCalls = trace.filter((item) => item.type === "tool.called").length;
  const sandboxed = trace.filter((item) => item.type === "tool.called" && item.name === "run_python").length;
  return (
    <details className="trace">
      <summary>
        <span className="trace-chevron">
          <Icon name="chevron" size={12} />
        </span>
        <Icon name="wrench" size={12} />
        {toolCalls > 0 ? `Used ${toolCalls} tool${toolCalls === 1 ? "" : "s"}` : "Agent trace"}
        {sandboxed > 0 && ` · ${sandboxed} sandboxed`}
      </summary>
      <div className="trace-body">
        {trace.map((item, i) => {
          if (item.type === "tool.called") {
            return (
              <div key={i} className="tool-line called">
                <ToolDetail name={item.name} kind="called" input={item.input} />
              </div>
            );
          }
          if (item.type === "tool.result") {
            return (
              <div key={i} className="tool-line result">
                <ToolDetail name={item.name} kind="result" output={item.output} />
              </div>
            );
          }
          return (
            <div key={i} className="trace-line">
              {item.text}
            </div>
          );
        })}
      </div>
    </details>
  );
}

export default function Chat() {
  // Session id comes from `?session=` when present (a shared/reloaded URL
  // picks its conversation back up), otherwise it's generated and written
  // into the URL by the mount effect below. The initializer only reads —
  // URL/localStorage writes are render-phase side effects and belong in
  // effects. Server render sees an empty id; the client initializer runs
  // during hydration and its value is the one that sticks (the id is never
  // rendered, so there's no mismatch).
  const [sessionId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("session") || crypto.randomUUID();
  });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  // A failed run keeps whatever trace it accumulated too, so it isn't just
  // silently discarded — it's shown alongside the error line.
  const [errorBanner, setErrorBanner] = useState<{ message: string; trace: TraceItem[] } | null>(null);
  // Last known context occupancy, persisted here because `reset()` wipes the
  // realtime log this is derived from between runs.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  // Which model this session is using, shown in the footer badge. Learned from
  // `run.started` (live) or a catch-up poll, and persisted so it survives a
  // reload. Sticky per session, so once known it stays.
  const [currentModel, setCurrentModel] = useState<ModelInfo | null>(null);
  // Storage restore happens in a mount effect (not the initializers) so the
  // server and client render the same empty first frame; `restored` gates the
  // save effect so an empty pre-restore state can't clobber the stored chat.
  const [restored, setRestored] = useState(false);
  // True when this run was picked back up from storage (a reload/reconnect
  // mid-run) rather than freshly sent. Only used to word the pending indicator
  // ("Reconnecting…" vs "Working…") so a re-sync reads as such; cleared once the
  // run settles or a new send starts.
  const [resumedRun, setResumedRun] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Transcript index of the reply whose text was just copied (drives the
  // brief "Copied" check state on its copy button).
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  // See the resume valve effect below for how these two interact.
  const resumedPendingRef = useRef(false);
  const liveMessageCountRef = useRef(0);
  // The event id of the in-flight run, captured from /api/chat's response (or
  // restored from storage on a reload). It's state, not a ref, because it's
  // persisted (so a reload can recover the run) and it drives the catch-up
  // poll effect. Stamped onto the assistant entry on completion so the reply is
  // rateable; null between runs.
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  // Event ids whose run has already been committed (completed or failed), so
  // the realtime path and the catch-up poll can't both append the same reply —
  // whichever settles it first wins; the other becomes a no-op.
  const settledRef = useRef<Set<string>>(new Set());
  // Latest derived `turns`, mirrored into a ref (assigned below the fold) so
  // `cancelledText` can read the live partial reply without being a per-render
  // closure — keeps it a stable dep for the catch-up poll effect.
  const turnsRef = useRef<TurnView[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    pruneStaleSessions();

    // Make the URL shareable/reload-safe without adding history entries.
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") !== sessionId) {
      url.searchParams.set("session", sessionId);
      window.history.replaceState(null, "", url);
    }

    const stored = loadSession(sessionId);
    if (stored) {
      setTranscript(stored.transcript);
      setContextUsage(stored.contextUsage);
      if (stored.currentModel) setCurrentModel(stored.currentModel);
      // A run was in flight when the page went away. Re-subscribe (the channel
      // is keyed by sessionId) for the live tail, and — when we know the event
      // id — also recover via the catch-up poll (the poll effect keys off
      // `pendingEventId`), which works even if the run already finished. Only
      // legacy sessions without a stored event id fall back to the give-up
      // valve below.
      if (stored.pendingRun) {
        setRunning(true);
        setResumedRun(true);
        if (stored.pendingEventId) setPendingEventId(stored.pendingEventId);
        else resumedPendingRef.current = true;
      }
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Persist on every meaningful change. `pendingRun: running` is what lets a
  // reload know whether to re-attach to a live run.
  useEffect(() => {
    if (!restored || !sessionId) return;
    saveSession(sessionId, {
      transcript,
      contextUsage,
      pendingRun: running,
      pendingEventId: running ? (pendingEventId ?? undefined) : undefined,
      currentModel: currentModel ?? undefined,
    });
  }, [restored, sessionId, transcript, contextUsage, running, pendingEventId, currentModel]);

  const { messages, reset } = useRealtime({
    channel: chatChannel(sessionId),
    topics: ["tokens", "status"],
    token: async () => {
      const res = await fetch("/api/realtime-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      return res.json();
    },
    // Only subscribe while a run is actually in flight — no point holding a
    // connection open (and no realtime token to mint) between sends.
    enabled: running,
    // Without this the browser's realtime WebSocket always targets Inngest
    // Cloud — set NEXT_PUBLIC_INNGEST_BASE_URL=http://localhost:8288 to run
    // fully against the Dev Server. Unset (production/Cloud), the default
    // stands and behavior is unchanged.
    apiBaseUrl: process.env.NEXT_PUBLIC_INNGEST_BASE_URL,
  });

  // Resume valve: after restoring a pendingRun we re-subscribe, but realtime
  // doesn't replay history — if the run already finished while the page was
  // away, nothing will ever arrive. Give it RESUME_GIVE_UP_MS; if not a
  // single message has landed, stop waiting (the transcript itself was
  // already restored, only the in-flight reply is lost).
  liveMessageCountRef.current = messages.all.length;

  useEffect(() => {
    if (!restored || !resumedPendingRef.current) return;
    const timer = setTimeout(() => {
      resumedPendingRef.current = false;
      if (liveMessageCountRef.current === 0) setRunning(false);
    }, RESUME_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [restored]);

  // Derive the entire live view from the flat message log on every render.
  // Nothing here mutates state — it's a pure fold over `messages.all`.
  const { turns, toolLines, runCompletedText, runNewMessages, runFailedError, runCancelled, trace, latestUsage, runModel } = useMemo(() => {
    // Per turn, token deltas arrive as one or more "attempts": a fresh
    // attempt starts whenever `seq: 0` shows up again (the step retried).
    // Only the most recent attempt is live; anything before it is a replay
    // that's being superseded, so it's discarded rather than concatenated.
    const attemptsByTurn = new Map<number, { seq: number; delta: string }[][]>();
    const finalTextByTurn = new Map<number, string>();
    const toolLines: ToolLine[] = [];
    // Every status event worth keeping, in arrival order — this becomes the
    // persisted trace once the run finishes (see the effect below).
    const traceRaw: TraceItem[] = [];
    let runCompletedText: string | null = null;
    // Optional-chained/nullish-coalesced below so a worker still publishing
    // the pre-newMessages shape (undefined `newMessages`) can't crash the
    // fold — the client just falls back to text-only replay for that turn.
    let runNewMessages: ChatMessage[] | null = null;
    let runFailedError: string | null = null;
    let runCancelled = false;
    let latestUsage: ContextUsage | null = null;
    let runModel: ModelInfo | null = null;

    for (const msg of messages.all) {
      if (msg.kind !== "data") continue;

      if (msg.topic === "tokens") {
        const { turn, seq, delta } = msg.data;
        let attempts = attemptsByTurn.get(turn);
        if (!attempts) {
          attempts = [];
          attemptsByTurn.set(turn, attempts);
        }
        if (seq === 0 || attempts.length === 0) attempts.push([]);
        attempts[attempts.length - 1]!.push({ seq, delta });
        continue;
      }

      if (msg.topic === "status") {
        const status = msg.data as StatusMessage;
        switch (status.type) {
          case "turn.completed":
            finalTextByTurn.set(status.turn, status.text);
            traceRaw.push({ type: "turn.completed", text: status.text });
            // Messages arrive in turn order, so the last one seen is current.
            // Optional-chained so a worker still publishing the pre-usage
            // shape can't crash the fold.
            if (status.usage?.contextWindow) latestUsage = status.usage;
            break;
          case "tool.called":
            toolLines.push({
              turn: status.turn,
              kind: "called",
              name: status.name,
              // Only non-run_python renders from `detail`; run_python renders
              // from the structured `input` (clipped at display). Skip
              // stringifying its potentially large `code` on every fold pass.
              detail: status.name === "run_python" ? "" : JSON.stringify(status.input),
              input: status.input,
            });
            traceRaw.push({ type: "tool.called", name: status.name, input: status.input });
            break;
          case "tool.result":
            toolLines.push({ turn: status.turn, kind: "result", name: status.name, detail: status.output });
            traceRaw.push({ type: "tool.result", name: status.name, output: status.output });
            break;
          case "run.completed":
            runCompletedText = status.text;
            runNewMessages = status.newMessages ?? null;
            break;
          case "run.failed":
            runFailedError = status.error;
            break;
          case "run.cancelled":
            runCancelled = true;
            break;
          case "run.started":
            runModel = { variant: status.variant, model: status.model };
            break;
        }
      }
    }

    // On a completed run, the last `turn.completed` always duplicates the
    // final answer (see worker/agent.ts: it's published for every turn,
    // including the one whose text becomes `run.completed`'s text) — drop it
    // so the trace only holds *intermediate* turn texts, not a repeat of
    // what's already the bubble's main content. A failed run's error message
    // duplicates nothing, so its trace keeps every turn text.
    const lastTurnCompleted = traceRaw.findLastIndex((item) => item.type === "turn.completed");
    const trace =
      runCompletedText === null || lastTurnCompleted === -1
        ? traceRaw
        : traceRaw.filter((_, i) => i !== lastTurnCompleted);

    const turnNumbers = new Set<number>([
      ...attemptsByTurn.keys(),
      ...finalTextByTurn.keys(),
      // Include turns that only have tool activity. After a mid-stream
      // reconnect (e.g. a refresh), a turn's token deltas and turn.completed
      // were published before we re-subscribed and are gone (realtime doesn't
      // replay), yet its tool.called/tool.result still arrive. Without this,
      // those tool lines have no turn to render under and silently vanish.
      ...toolLines.map((l) => l.turn),
    ]);
    const turns: TurnView[] = [...turnNumbers]
      .sort((a, b) => a - b)
      .map((turn) => {
        const finalText = finalTextByTurn.get(turn);
        if (finalText !== undefined) {
          return { turn, text: finalText, streaming: false };
        }
        const attempts = attemptsByTurn.get(turn) ?? [];
        // No tokens and no final text — a tool-only turn (see above). Render
        // its tool lines with no text bubble and no streaming caret.
        if (attempts.length === 0) {
          return { turn, text: "", streaming: false };
        }
        const latestAttempt = attempts.at(-1) ?? [];
        const text = [...latestAttempt]
          .sort((a, b) => a.seq - b.seq)
          .map((c) => c.delta)
          .join("");
        return { turn, text, streaming: true };
      });

    return { turns, toolLines, runCompletedText, runNewMessages, runFailedError, runCancelled, trace, latestUsage, runModel };
  }, [messages.all]);

  // Mirror the freshly-derived turns into the ref so `cancelledText` (stable)
  // can read the current partial reply at cancel time.
  turnsRef.current = turns;

  // Surface the live model as soon as `run.started` reports it.
  useEffect(() => {
    if (runModel) setCurrentModel(runModel);
  }, [runModel?.variant, runModel?.model]);

  // Append a finished reply to the client-owned transcript, exactly once per
  // run. Both the realtime `run.completed` path and the catch-up poll funnel
  // through here; `settledRef` guards against a double-append when both fire
  // for the same run. The stamped `eventId` is what makes the reply rateable
  // (the 👍/👎 controls render only on entries that have one), and
  // `apiMessages` carries the tool context forward to the next request.
  const commitReply = useCallback(
    (opts: {
      text: string;
      newMessages?: ChatMessage[];
      eventId?: string;
      trace?: TraceItem[];
      usage?: ContextUsage | null;
    }) => {
      if (opts.eventId) {
        if (settledRef.current.has(opts.eventId)) return;
        settledRef.current.add(opts.eventId);
      }
      // Prefer the trace reconstructed from the durable `newMessages` (complete
      // even after a lossy reconnect or a catch-up recovery); fall back to the
      // live-captured trace only when there are no durable messages.
      const reconstructed =
        opts.newMessages && opts.newMessages.length > 0 ? traceFromMessages(opts.newMessages) : [];
      const trace =
        reconstructed.length > 0
          ? reconstructed
          : opts.trace && opts.trace.length > 0
            ? opts.trace
            : undefined;
      setTranscript((t) => [
        ...t,
        {
          role: "assistant",
          content: opts.text,
          trace,
          apiMessages: opts.newMessages,
          eventId: opts.eventId,
        },
      ]);
      if (opts.usage) setContextUsage(opts.usage);
      setPendingEventId(null);
      setRunning(false);
      setResumedRun(false);
    },
    [],
  );

  // Same once-only guard for a failed run — realtime `run.failed` or a `failed`
  // catch-up poll, whichever lands first.
  const commitFailure = useCallback(
    (opts: { error: string; eventId?: string; trace?: TraceItem[]; usage?: ContextUsage | null }) => {
      if (opts.eventId) {
        if (settledRef.current.has(opts.eventId)) return;
        settledRef.current.add(opts.eventId);
      }
      setErrorBanner({ message: opts.error, trace: opts.trace ?? [] });
      // A failed run still consumed context on whatever turns did complete.
      if (opts.usage) setContextUsage(opts.usage);
      setPendingEventId(null);
      setRunning(false);
      setResumedRun(false);
    },
    [],
  );

  // Settle a cancelled run to a neutral "stopped" state (not an error). Reached
  // from three places — the Stop click (optimistic), the route's live
  // `run.cancelled`, and a `cancelled` catch-up poll — all funnelled through the
  // same `settledRef`/eventId guard so it appends at most once. `text` is
  // whatever partial reply had streamed so far (captured by the caller from the
  // live `turns`) with a "[stopped]" marker. No `eventId` is stamped on the
  // entry (so no 👍/👎 controls — a cancelled run never enqueued the deferred
  // feedback scorer), but it's still used for the dedupe guard.
  const commitCancellation = useCallback((opts: { text: string; eventId?: string }) => {
    if (opts.eventId) {
      if (settledRef.current.has(opts.eventId)) return;
      settledRef.current.add(opts.eventId);
    }
    setTranscript((t) => [...t, { role: "assistant", content: opts.text }]);
    setPendingEventId(null);
    setRunning(false);
    setResumedRun(false);
  }, []);

  // Build the "stopped" bubble text from whatever the live view has streamed so
  // far: the concatenated turn texts plus a marker (marker alone if nothing
  // streamed yet). Reads the live turns through `turnsRef` (assigned each
  // render, below the fold) so this callback stays stable — the catch-up poll
  // effect lists it as a dep, and a per-render identity would thrash the poll
  // timer.
  const cancelledText = useCallback(() => {
    const partial = turnsRef.current
      .map((t) => t.text)
      .filter(Boolean)
      .join("\n\n");
    return partial ? `${partial}\n\n[Stopped.]` : "[Stopped.]";
  }, []);

  // Realtime-driven settle: commit the finished reply (with its trace, captured
  // from `messages.all` above *before* reset()), then reset the realtime
  // accumulator so the next send starts clean.
  useEffect(() => {
    if (runCompletedText !== null) {
      commitReply({
        text: runCompletedText,
        newMessages: runNewMessages ?? undefined,
        eventId: pendingEventId ?? undefined,
        trace,
        usage: latestUsage,
      });
      reset();
    } else if (runFailedError !== null) {
      commitFailure({
        error: runFailedError,
        eventId: pendingEventId ?? undefined,
        trace,
        usage: latestUsage,
      });
      reset();
    } else if (runCancelled) {
      // A `run.cancelled` we didn't initiate (e.g. Stop was clicked in another
      // tab on this session). The Stop click in *this* tab settles optimistically
      // and resets before this ever fires.
      commitCancellation({ text: cancelledText(), eventId: pendingEventId ?? undefined });
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCompletedText, runFailedError, runCancelled]);

  // Catch-up poll: Inngest Realtime has no replay, so a dropped connection or a
  // mid-run reload can miss `run.completed`. Whenever a run is in flight
  // (`pendingEventId` set), poll api/run-status as a safety net until it's
  // terminal, and commit through the same guarded path as realtime. On a
  // healthy connection realtime settles first and the first poll finds it
  // already settled; on a bad one, the poll recovers the reply.
  useEffect(() => {
    const eventId = pendingEventId;
    if (!eventId || settledRef.current.has(eventId)) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/run-status?eventId=${encodeURIComponent(eventId)}`);
        if (res.ok) {
          const data = (await res.json()) as {
            status: "running" | "completed" | "failed" | "cancelled";
            output?: { text?: string; newMessages?: ChatMessage[]; variant?: string; model?: string };
          };
          if (cancelled) return;
          if (data.status === "completed") {
            // The run output carries the variant and model slug even when we
            // missed the live run.started — keep the model badge accurate on
            // recovery (the slug drives the label; see modelLabel).
            if (data.output?.variant)
              setCurrentModel({ variant: data.output.variant, model: data.output.model });
            commitReply({ text: data.output?.text ?? "", newMessages: data.output?.newMessages, eventId });
            return;
          }
          if (data.status === "failed") {
            commitFailure({ error: "Run failed", eventId });
            return;
          }
          if (data.status === "cancelled") {
            commitCancellation({ text: cancelledText(), eventId });
            return;
          }
        }
      } catch {
        // Transient — fall through to retry.
      }
      if (cancelled) return;
      attempts += 1;
      // Give up quietly at the cap; realtime may still deliver, and the reply
      // is recoverable on the next reload.
      if (attempts >= POLL_MAX_ATTEMPTS) return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    // First poll after one interval, giving the live path a chance to win on a
    // healthy connection.
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pendingEventId, commitReply, commitFailure, commitCancellation, cancelledText]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, turns, toolLines]);

  // Auto-grow the composer: reset to auto so it can shrink, then fit content
  // up to COMPOSER_MAX_HEIGHT (past that it scrolls internally).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [input]);

  async function copyReply(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((c) => (c === index ? null : c)), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — nothing to show.
    }
  }

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || running) return;

    setErrorBanner(null);
    const nextTranscript: TranscriptEntry[] = [...transcript, { role: "user", content: text }];
    setTranscript(nextTranscript);
    setInput("");
    setRunning(true);
    setResumedRun(false);

    // Expand each entry into the API messages it actually produced
    // (tool_use/tool_result blocks and all) rather than just its display
    // text, so the model keeps tool context across messages instead of
    // re-deriving it from scratch every turn. Entries without `apiMessages` —
    // user-authored entries, and older localStorage sessions saved before
    // this field existed — fall back to their plain `{ role, content }` text.
    const wireMessages: ChatMessage[] = nextTranscript.flatMap((e) => {
      if (e.apiMessages && e.apiMessages.length > 0) return e.apiMessages;
      return [
        e.role === "assistant"
          ? { role: "assistant", content: e.content }
          : { role: "user", content: e.content },
      ];
    });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: wireMessages }),
      });
      if (!res.ok) throw new Error(`chat request failed: ${res.status}`);
      // Remember which event this run belongs to: it's stamped onto the reply
      // (so it's rateable), persisted so a reload can recover the run, and it
      // drives the catch-up poll effect above.
      const { eventId } = (await res.json()) as { eventId?: string };
      setPendingEventId(eventId ?? null);
    } catch (err) {
      // The run never started, so no realtime message will ever unwind the
      // in-flight state — clear it here and surface the failure instead of
      // leaving the composer disabled forever.
      setErrorBanner({ message: err instanceof Error ? err.message : String(err), trace: [] });
      setRunning(false);
    }
  }

  // Record a 👍/👎 on one assistant turn. Optimistically reflects the choice in
  // the transcript (so it persists to localStorage and survives reloads), then
  // fires the feedback event; on failure it rolls the selection back rather
  // than leaving a rating shown that never reached the scorer.
  async function sendFeedback(index: number, choice: "up" | "down") {
    const entry = transcript[index];
    if (!entry?.eventId || entry.feedback === choice) return;

    const previous = entry.feedback;
    setTranscript((t) => t.map((e, i) => (i === index ? { ...e, feedback: choice } : e)));

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: entry.eventId, helpful: choice === "up" }),
      });
      if (!res.ok) throw new Error(`feedback request failed: ${res.status}`);
    } catch {
      // Best-effort: undo the optimistic selection so the UI doesn't claim a
      // rating that was never recorded.
      setTranscript((t) => t.map((e, i) => (i === index ? { ...e, feedback: previous } : e)));
    }
  }

  // Stop the in-flight run. Settles the UI optimistically (guarded by
  // settledRef, so the route's live `run.cancelled` and the catch-up poll can't
  // double-append) and resets the realtime accumulator, then fires the durable
  // cancel: /api/cancel sends `chat/cancel.requested`, which `cancelOn` uses to
  // tear the run down at its next step boundary. Fire-and-forget — the UI has
  // already settled; the event is what makes the worker actually stop.
  function cancelRun() {
    if (!running) return;
    commitCancellation({ text: cancelledText(), eventId: pendingEventId ?? undefined });
    reset();
    fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }

  // Start a fresh conversation: navigate to a clean URL (no `?session=`), so the
  // mount effect mints a new session id and everything — transcript, realtime
  // subscription, refs — resets from scratch. The current session stays in
  // localStorage (pruned after 7 days), reachable via its own URL. An in-flight
  // run keeps going durably server-side; we just stop watching it.
  function newSession() {
    window.location.assign(window.location.pathname);
  }

  const liveUsage = latestUsage ?? contextUsage;
  const isEmpty = transcript.length === 0 && turns.length === 0 && !running && !errorBanner;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark">
              <Spark size={14} />
            </span>
            <div className="brand-text">
              <h1>Token Streaming Agent</h1>
              <p>Live tokens over Inngest Realtime. Durable steps underneath.</p>
            </div>
          </div>
          <button type="button" className="ghost-btn" onClick={newSession} title="Start a new conversation">
            <Icon name="plus" size={15} />
            <span>New chat</span>
          </button>
        </div>
      </header>

      <main className="thread">
        {isEmpty && (
          <div className="empty-state">
            <span className="empty-mark">
              <Spark size={22} />
            </span>
            <h2>What should we dig into?</h2>
            <p>
              Multi-step analyses: the agent fetches data, runs sandboxed Python, and streams every token as each
              durable step completes.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} type="button" className="suggestion" onClick={() => send(s.prompt)}>
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-prompt">{s.prompt}</span>
                </button>
              ))}
            </div>
            <p className="sandbox-note">
              <Icon name="shield" size={12} />
              Model-written Python runs in an isolated sandbox: no files, network, or secrets.
            </p>
          </div>
        )}

        {transcript.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              <div className="user-bubble">{m.content}</div>
            </div>
          ) : (
            <div key={i} className="msg assistant">
              <span className="avatar">
                <Spark size={13} />
              </span>
              <div className="assistant-body">
                <Markdown text={m.content} />
                {m.trace && m.trace.length > 0 && <TraceDetails trace={m.trace} />}
                <div className="msg-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={copiedIndex === i ? "Copied" : "Copy"}
                    aria-label="Copy response"
                    onClick={() => copyReply(i, m.content)}
                  >
                    <Icon name={copiedIndex === i ? "check" : "copy"} size={15} />
                  </button>
                  {m.eventId && (
                    <div className="feedback" role="group" aria-label="Rate this response">
                      <button
                        type="button"
                        className={`icon-btn feedback-btn up${m.feedback === "up" ? " selected" : ""}`}
                        aria-pressed={m.feedback === "up"}
                        title="Helpful"
                        onClick={() => sendFeedback(i, "up")}
                      >
                        <Icon name="thumbUp" size={15} />
                      </button>
                      <button
                        type="button"
                        className={`icon-btn feedback-btn down${m.feedback === "down" ? " selected" : ""}`}
                        aria-pressed={m.feedback === "down"}
                        title="Not helpful"
                        onClick={() => sendFeedback(i, "down")}
                      >
                        <Icon name="thumbDown" size={15} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ),
        )}

        {/* The in-flight run: one assistant row holding every live turn's text
            and tool lines. Before anything has streamed it shows the pending
            indicator — "Reconnecting…" when re-syncing a run picked back up
            from storage, "Working…" on a fresh send. */}
        {(turns.length > 0 || (running && !errorBanner)) && (
          <div className="msg assistant live">
            <span className={`avatar${running ? " live" : ""}`}>
              <Spark size={13} />
            </span>
            <div className="assistant-body">
              {turns.length === 0 && (
                <div className="pending" aria-live="polite">
                  <span className="typing-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="shimmer">{resumedRun ? "Reconnecting…" : "Working…"}</span>
                </div>
              )}
              {turns.map((turn) => {
                const lines = toolLines.filter((l) => l.turn === turn.turn);
                return (
                  <div key={turn.turn} className="live-turn">
                    {(turn.text || turn.streaming) && (
                      <div className="live-text">
                        {/* Render plain text while streaming — the Markdown renderer
                            re-parses the whole turn on every ~40ms token batch, which is
                            wasted work (and an OOM risk on a long/runaway reply) frame
                            after frame. Format once the turn settles. The container's
                            white-space: pre-wrap keeps newlines readable meanwhile. */}
                        {turn.streaming ? turn.text : <Markdown text={turn.text} />}
                        {turn.streaming && <span className="caret" />}
                      </div>
                    )}
                    {lines.length > 0 && (
                      <div className="live-tools">
                        {lines.map((l, i) => {
                          // Display-only pairing: the k-th call of a tool in this turn
                          // is still running until its k-th result has arrived.
                          const nth = lines.slice(0, i).filter((o) => o.kind === "called" && o.name === l.name).length;
                          const results = lines.filter((o) => o.kind === "result" && o.name === l.name).length;
                          const pending = running && l.kind === "called" && nth >= results;
                          return (
                            <div key={i} className={`tool-line ${l.kind}${pending ? " pending" : ""}`}>
                              {pending && <span className="spinner" aria-label="Running" />}
                              <div className="tool-line-body">
                                <ToolDetail
                                  name={l.name}
                                  kind={l.kind}
                                  input={l.input}
                                  output={l.kind === "result" ? l.detail : undefined}
                                />
                                {pending && l.name === "run_python" && (
                                  <span className="shimmer sandbox-running">Running in sandbox…</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {errorBanner && (
          <div className="notice error" role="alert">
            <Icon name="alert" size={16} />
            <div className="notice-body">
              <strong>Run failed</strong>
              <span>{errorBanner.message}</span>
              {errorBanner.trace.length > 0 && <TraceDetails trace={errorBanner.trace} />}
            </div>
          </div>
        )}

        <div ref={bottomRef} className="scroll-anchor" />
      </main>

      <div className="composer-dock">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter inserts a newline; skip while an IME
              // composition is open so confirming a candidate doesn't send.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder={running ? "Waiting for the agent…" : "Ask about the weather anywhere…"}
            disabled={running}
            aria-label="Message"
          />
          <div className="composer-footer">
            <div className="composer-meta">
              {/* Which model this session is talking to (sticky per session).
                  Shown once known — live from run.started, or restored. */}
              {currentModel && (
                <span className="model-badge" title={currentModel.model ? `Model: ${currentModel.model}` : undefined}>
                  <span className={`model-badge-dot${running ? " live" : ""}`} />
                  {modelLabel(currentModel)}
                </span>
              )}
              {/* Live value beats the persisted one mid-run; hidden until the
                  first turn reports usage. */}
              {liveUsage && <ContextMeter usage={liveUsage} />}
            </div>
            {/* While a run is in flight Send becomes Stop, which cancels it
                durably (cancelOn). Between runs it's the normal submit. */}
            {running ? (
              <button type="button" className="send-btn stop" onClick={cancelRun} title="Stop" aria-label="Stop">
                <span className="stop-square" />
              </button>
            ) : (
              <button type="submit" className="send-btn" disabled={!input.trim()} title="Send" aria-label="Send">
                <Icon name="arrowUp" size={16} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-hint">
          <Icon name="shield" size={11} /> Python runs in an isolated sandbox · Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
