"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "inngest/react";
import {
  chatChannel,
  type ChatMessage,
  type ContextUsage,
  type StatusMessage,
} from "../../inngest/channel";

type ToolLine = { turn: number; kind: "called" | "result"; name: string; detail: string };

type TurnView = { turn: number; text: string; streaming: boolean };

// Client-side only — never sent over the wire. One entry per `status`
// message worth keeping once a run finishes: tool calls/results and
// intermediate turn texts (i.e. everything except the final turn's text,
// which is already the bubble's main content). Ordered by arrival.
type TraceItem =
  | { type: "tool.called"; name: string; input: unknown }
  | { type: "tool.result"; name: string; output: string }
  | { type: "turn.completed"; text: string };

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
};

const DEMO_PROMPT = "What's the weather in Tokyo, in Fahrenheit?";

// localStorage persistence so a conversation survives reloads and Inngest
// timeouts: the URL carries `?session=<id>` and the transcript is stored
// under `chat:<id>`. localStorage never expires on its own, so every load
// prunes entries older than STORAGE_TTL_MS.
const STORAGE_PREFIX = "chat:";
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// How long a resumed subscription waits for any sign of the pending run
// before concluding it finished (or died) while the page was away.
const RESUME_GIVE_UP_MS = 30_000;

type StoredSession = {
  savedAt: number;
  transcript: TranscriptEntry[];
  contextUsage: ContextUsage | null;
  // Set while a run is in flight so a reload can re-subscribe and pick the
  // stream back up; cleared when the run completes or fails.
  pendingRun: boolean;
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
  const fraction = Math.min(1, used / usage.contextWindow);
  // The fill escalates from accent to danger as the window fills; the number
  // in the label carries the same information, so color is never the only
  // signal.
  const high = fraction > 0.8;
  return (
    <div className="context-meter" title={`${used.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`}>
      <span className="context-meter-label">
        Context · {formatTokens(used)} / {formatTokens(usage.contextWindow)}
      </span>
      <div className={`context-meter-track${high ? " high" : ""}`}>
        <div className="context-meter-fill" style={{ width: `${(fraction * 100).toFixed(2)}%` }} />
      </div>
    </div>
  );
}

function TraceDetails({ trace }: { trace: TraceItem[] }) {
  const toolCalls = trace.filter((item) => item.type === "tool.called").length;
  return (
    <details className="trace">
      <summary>
        Agent trace · {toolCalls} tool call{toolCalls === 1 ? "" : "s"}
      </summary>
      <div className="trace-body">
        {trace.map((item, i) => {
          if (item.type === "tool.called") {
            return (
              <div key={i} className="tool-line called">
                <span className="tool-name">{item.name}</span> called with{" "}
                <code>{JSON.stringify(item.input)}</code>
              </div>
            );
          }
          if (item.type === "tool.result") {
            return (
              <div key={i} className="tool-line result">
                <span className="tool-name">{item.name}</span> returned <code>{item.output}</code>
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
  // Storage restore happens in a mount effect (not the initializers) so the
  // server and client render the same empty first frame; `restored` gates the
  // save effect so an empty pre-restore state can't clobber the stored chat.
  const [restored, setRestored] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // See the resume valve effect below for how these two interact.
  const resumedPendingRef = useRef(false);
  const liveMessageCountRef = useRef(0);

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
      // A run was in flight when the page went away: re-subscribe (the
      // channel is keyed by sessionId) and let the still-executing run's
      // durable statuses land. The give-up effect below handles the case
      // where the run already ended and nothing will ever arrive.
      if (stored.pendingRun) {
        resumedPendingRef.current = true;
        setRunning(true);
      }
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Persist on every meaningful change. `pendingRun: running` is what lets a
  // reload know whether to re-attach to a live run.
  useEffect(() => {
    if (!restored || !sessionId) return;
    saveSession(sessionId, { transcript, contextUsage, pendingRun: running });
  }, [restored, sessionId, transcript, contextUsage, running]);

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
  const { turns, toolLines, runCompletedText, runNewMessages, runFailedError, trace, latestUsage } = useMemo(() => {
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
    let latestUsage: ContextUsage | null = null;

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
              detail: JSON.stringify(status.input),
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
          case "run.started":
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

    const turnNumbers = new Set<number>([...attemptsByTurn.keys(), ...finalTextByTurn.keys()]);
    const turns: TurnView[] = [...turnNumbers]
      .sort((a, b) => a - b)
      .map((turn) => {
        const finalText = finalTextByTurn.get(turn);
        if (finalText !== undefined) {
          return { turn, text: finalText, streaming: false };
        }
        const attempts = attemptsByTurn.get(turn) ?? [];
        const latestAttempt = attempts.at(-1) ?? [];
        const text = [...latestAttempt]
          .sort((a, b) => a.seq - b.seq)
          .map((c) => c.delta)
          .join("");
        return { turn, text, streaming: true };
      });

    return { turns, toolLines, runCompletedText, runNewMessages, runFailedError, trace, latestUsage };
  }, [messages.all]);

  // Side effects triggered by the derived status: append the finished
  // message (with its trace) to the client-owned transcript, stop showing
  // the run as live, and reset the realtime accumulator so the next send
  // starts from a clean slate (rather than replaying this run's messages
  // forever). The trace is captured from `messages.all` above *before*
  // `reset()` runs, since reset() is what makes the live tool-activity
  // lines disappear.
  useEffect(() => {
    if (runCompletedText !== null) {
      setTranscript((t) => [
        ...t,
        { role: "assistant", content: runCompletedText, trace, apiMessages: runNewMessages ?? undefined },
      ]);
      if (latestUsage) setContextUsage(latestUsage);
      setRunning(false);
      reset();
    } else if (runFailedError !== null) {
      setErrorBanner({ message: runFailedError, trace });
      // A failed run still consumed context on whatever turns did complete.
      if (latestUsage) setContextUsage(latestUsage);
      setRunning(false);
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCompletedText, runFailedError]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, turns, toolLines]);

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || running) return;

    setErrorBanner(null);
    const nextTranscript: TranscriptEntry[] = [...transcript, { role: "user", content: text }];
    setTranscript(nextTranscript);
    setInput("");
    setRunning(true);

    // Expand each entry into the API messages it actually produced
    // (tool_use/tool_result blocks and all) rather than just its display
    // text, so the model keeps tool context across messages instead of
    // re-deriving it from scratch every turn. Entries without `apiMessages` —
    // user-authored entries, and older localStorage sessions saved before
    // this field existed — fall back to their plain `{ role, content }` text.
    const wireMessages: ChatMessage[] = nextTranscript.flatMap((e) =>
      e.apiMessages && e.apiMessages.length > 0 ? e.apiMessages : [{ role: e.role, content: e.content }],
    );

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: wireMessages }),
      });
      if (!res.ok) throw new Error(`chat request failed: ${res.status}`);
    } catch (err) {
      // The run never started, so no realtime message will ever unwind the
      // in-flight state — clear it here and surface the failure instead of
      // leaving the composer disabled forever.
      setErrorBanner({ message: err instanceof Error ? err.message : String(err), trace: [] });
      setRunning(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-scroll">
        {transcript.length === 0 && turns.length === 0 && (
          <div className="empty-state">
            <p>No messages yet. Try the demo prompt:</p>
            <button className="demo-prompt" onClick={() => send(DEMO_PROMPT)} disabled={running}>
              {DEMO_PROMPT}
            </button>
          </div>
        )}

        {transcript.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
            {m.trace && m.trace.length > 0 && <TraceDetails trace={m.trace} />}
          </div>
        ))}

        {turns.map((turn) => (
          <div key={turn.turn}>
            <div className="bubble assistant">
              {turn.text}
              {turn.streaming && <span className="caret" />}
            </div>
            {toolLines
              .filter((l) => l.turn === turn.turn)
              .map((l, i) => (
                <div key={i} className={`tool-line ${l.kind}`}>
                  {l.kind === "called" ? (
                    <>
                      <span className="tool-name">{l.name}</span> called with{" "}
                      <code>{l.detail}</code>
                    </>
                  ) : (
                    <>
                      <span className="tool-name">{l.name}</span> returned <code>{l.detail}</code>
                    </>
                  )}
                </div>
              ))}
          </div>
        ))}

        {errorBanner && (
          <div className="error-line">
            Run failed: {errorBanner.message}
            {errorBanner.trace.length > 0 && <TraceDetails trace={errorBanner.trace} />}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Live value beats the persisted one mid-run; hidden entirely until
          the first turn reports usage. */}
      {(latestUsage ?? contextUsage) && <ContextMeter usage={(latestUsage ?? contextUsage)!} />}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={running ? "Waiting for the agent…" : "Ask something…"}
          disabled={running}
        />
        <button type="submit" disabled={running || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
