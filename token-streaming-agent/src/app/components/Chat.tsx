"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "inngest/react";
import { chatChannel, type ChatMessage, type StatusMessage } from "../../inngest/channel";

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

// The wire contract (`ChatMessage`) only has `role`/`content` — this adds an
// optional client-side trace so a finished assistant turn can keep its tool
// activity around after the realtime messages that produced it are gone.
// Stripped back down to `ChatMessage` before every POST /api/chat.
type TranscriptEntry = ChatMessage & { trace?: TraceItem[] };

const DEMO_PROMPT = "What's the weather in Tokyo, and what's 87*23?";

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
  // One id per browser tab/session, generated once. There's no server-side
  // session store — the transcript below is the only place history lives.
  const [sessionId] = useState(() => crypto.randomUUID());
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  // A failed run keeps whatever trace it accumulated too, so it isn't just
  // silently discarded — it's shown alongside the error line.
  const [errorBanner, setErrorBanner] = useState<{ message: string; trace: TraceItem[] } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
  });

  // Derive the entire live view from the flat message log on every render.
  // Nothing here mutates state — it's a pure fold over `messages.all`.
  const { turns, toolLines, runCompletedText, runFailedError, trace } = useMemo(() => {
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
    let runFailedError: string | null = null;

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

    return { turns, toolLines, runCompletedText, runFailedError, trace };
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
      setTranscript((t) => [...t, { role: "assistant", content: runCompletedText, trace }]);
      setRunning(false);
      reset();
    } else if (runFailedError !== null) {
      setErrorBanner({ message: runFailedError, trace });
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

    // Wire format is still plain `{ role, content }` — the worker doesn't
    // know about traces, so strip them back off before sending.
    const wireMessages: ChatMessage[] = nextTranscript.map(({ role, content }) => ({ role, content }));

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
