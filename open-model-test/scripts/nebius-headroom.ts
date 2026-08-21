// Δ3 gate (spec v3 §14): Nebius rate-limit headroom probe. Fires waves of
// parallel streaming generations against the configured M3 endpoint and
// reads the x-ratelimit-* response headers (Finding 17c design) — answering
// "is the configured concurrency safe for the batch matrix, and how much
// headroom is there?" with data instead of guesses.
//
// Raw fetch (not the SDK) so response headers are directly readable; SSE
// parsed only for first-token timing and usage. Requests are tiny and run
// with reasoning off (Δ1: reasoning_effort "none") — total probe spend is
// fractions of a cent.
//
//   bun run probe:nebius [wave sizes — default: 4 8 12]

import { config } from "../src/config";
import { providerTarget } from "../src/models/adapter";

const model = config.models.find((m) => m.adapter === "openai_compat");
if (!model) {
  console.error("no openai_compat model in config");
  process.exit(1);
}
const { baseURL, apiKeyEnv } = providerTarget(model);
const apiKey = process.env[apiKeyEnv];
if (!apiKey) {
  console.error(`${apiKeyEnv} is required for ${baseURL} (see .env.example)`);
  process.exit(1);
}

const waves = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (waves.length === 0) waves.push(4, 8, 12);

type ReqResult = {
  i: number;
  status: number | null;
  error?: string;
  ttftMs: number | null;
  latencyMs: number;
  completionTokens: number | null;
  overLimit: boolean;
  headers: Record<string, string>;
};

function snapshotHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) {
    if (k.startsWith("x-ratelimit") || k === "x-request-id") out[k] = v;
  }
  return out;
}

async function oneRequest(i: number): Promise<ReqResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model!.model,
        messages: [{ role: "user", content: "Reply with one sentence naming a Go stdlib package." }],
        max_tokens: 60,
        temperature: 0.2,
        reasoning_effort: "none",
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const headers = snapshotHeaders(res.headers);
    const base = {
      i,
      status: res.status,
      ttftMs: null as number | null,
      latencyMs: Date.now() - t0,
      completionTokens: null as number | null,
      overLimit: res.headers.get("x-ratelimit-over-limit") === "yes",
      headers,
    };
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      return { ...base, error: detail.slice(0, 160) };
    }
    let firstTokenAt: number | null = null;
    let completionTokens: number | null = null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") break outer;
          try {
            const chunk = JSON.parse(payload);
            const content = chunk.choices?.[0]?.delta?.content;
            if (content && firstTokenAt === null) firstTokenAt = Date.now();
            if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
          } catch {
            // partial JSON line or keepalive — next read completes it
          }
        }
      }
    }
    return { ...base, ttftMs: firstTokenAt === null ? null : firstTokenAt - t0, completionTokens };
  } catch (e) {
    return {
      i,
      status: null,
      error: (e as Error).message,
      ttftMs: null,
      latencyMs: Date.now() - t0,
      completionTokens: null,
      overLimit: false,
      headers: {},
    };
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

console.log(`model: ${model.model} via ${baseURL}  (reasoning off)\n`);

let lastHeaders: Record<string, string> = {};
for (const w of waves) {
  const results = await Promise.all(Array.from({ length: w }, (_, i) => oneRequest(i)));
  const ok = results.filter((r) => r.status === 200);
  const errs = results.filter((r) => r.status !== 200);
  const withHeaders = results.find((r) => Object.keys(r.headers).length > 0);
  if (withHeaders) lastHeaders = withHeaders.headers;
  const ttfts = ok.map((r) => r.ttftMs).filter((x): x is number => x !== null);
  console.log(`wave ${String(w).padStart(2)} parallel — ok ${ok.length}/${w}`);
  if (errs.length) {
    for (const e of errs) console.log(`  #${e.i}: ${e.status ?? "fetch-error"}${e.error ? ` ${e.error}` : ""}`);
  }
  if (ttfts.length) {
    console.log(`  ttft min/med/max: ${Math.min(...ttfts)} / ${median(ttfts)} / ${Math.max(...ttfts)} ms`);
  }
  const over = results.filter((r) => r.overLimit).length;
  if (over) console.log(`  over-limit (early warning): ${over}`);
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\nx-ratelimit header snapshot (most recent response carrying them):");
if (Object.keys(lastHeaders).length === 0) {
  console.log("  (none — responses carried no x-ratelimit headers)");
} else {
  for (const [k, v] of Object.entries(lastHeaders)) console.log(`  ${k}: ${v}`);
}
