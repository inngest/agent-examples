// Local traffic generator for phase-2-eval-scoring. Loops forever, sending
// chat prompts and simulated 👍/👎 feedback, so the Inngest experiment view
// fills up with scores without a human clicking through the UI by hand.
//
// Run alongside `bun run dev`:
//   bun run populate

const BASE_URL =
  process.env.POPULATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

const PROMPTS = [
  "In one sentence, what is a mutex?",
  "In one sentence, what does `git rebase` do?",
  "In one sentence, why is the sky blue?",
  "In one sentence, what is a closure in JavaScript?",
  "In one sentence, what's the difference between TCP and UDP?",
  "In one sentence, what year did the Berlin Wall fall?",
  "In one sentence, what is Big O notation?",
  "In one sentence, what is a REST API?",
  "In one sentence, what's the capital of Australia?",
  "In one sentence, what is recursion?",
  "In one sentence, what does 'idempotent' mean?",
  "In one sentence, who wrote Pride and Prejudice?",
  "In one sentence, what is a race condition?",
  "In one sentence, what's the boiling point of water at sea level, in Celsius?",
  "In one sentence, what's the difference between `let` and `const` in JS?",
];

// These per-variant thumbs-up rates are synthetic, not a judgment of model
// quality — they exist purely so the experiment view shows a visible spread
// between control and candidate instead of two flat, indistinguishable bars.
const UP_PROBABILITY: Record<string, number> = { control: 0.6, candidate: 0.85 };
const DEFAULT_UP_PROBABILITY = 0.7;
const SKIP_FEEDBACK_PROBABILITY = 0.15;

const BASE_INTERVAL_MS = Number(process.env.POPULATE_INTERVAL_MS ?? 4000);

// Only accept a positive integer; anything else (unset, garbage, 0, negative)
// falls back to unbounded rather than silently becoming `>= NaN`, which is
// always false and would run forever despite the user asking for a bound.
function parseTargetCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.log(`ignoring invalid POPULATE_COUNT=${JSON.stringify(raw)}; expected a positive integer`);
    return undefined;
  }
  return parsed;
}

const TARGET_COUNT = parseTargetCount(process.env.POPULATE_COUNT);

type ChatResult = { reply: string; variant?: string; messageId: string };

let attempts = 0;
let repliesReceived = 0;
let feedbackSent = 0;
const tally: Record<"control" | "candidate" | "unknown", { up: number; down: number }> = {
  control: { up: 0, down: 0 },
  candidate: { up: 0, down: 0 },
  unknown: { up: 0, down: 0 },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(prompt: string, max = 60): string {
  return prompt.length > max ? `${prompt.slice(0, max)}…` : prompt;
}

// Jittered so requests don't land in lockstep: somewhere in [0.5x, 1.5x] of base.
function jitteredInterval(base: number): number {
  return Math.round(base * (0.5 + Math.random()));
}

async function sendChat(prompt: string): Promise<ChatResult | undefined> {
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log(`chat failed: ${res.status} ${(body as { error?: string }).error ?? ""}`);
      return undefined;
    }
    return (await res.json()) as ChatResult;
  } catch (err) {
    console.log(`chat request failed: ${(err as Error).message}`);
    return undefined;
  }
}

// Returns whether the feedback actually landed, so callers only credit the
// tally for feedback that was really recorded (not attempted-and-failed).
async function sendFeedback(messageId: string, up: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, up }),
    });
    if (!res.ok) {
      console.log(`feedback failed: ${res.status}`);
      return false;
    }
    feedbackSent++;
    return true;
  } catch (err) {
    console.log(`feedback request failed: ${(err as Error).message}`);
    return false;
  }
}

function printSummary(): void {
  console.log("\n--- populate-scores summary ---");
  console.log(`chat attempts:      ${attempts}`);
  console.log(`successful replies: ${repliesReceived}`);
  console.log(`feedback sent:      ${feedbackSent}`);
  for (const variant of ["control", "candidate", "unknown"] as const) {
    console.log(`  ${variant}: ${tally[variant].up} up / ${tally[variant].down} down`);
  }
}

process.on("SIGINT", () => {
  printSummary();
  process.exit(0);
});

while (true) {
  const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const result = await sendChat(prompt);
  attempts++;

  if (result) {
    repliesReceived++;

    // The server only ever returns "control" or "candidate", but don't trust
    // that at the type level — an unrecognized value falls back to the
    // existing "unknown" bucket instead of being force-cast into a tally key
    // that doesn't exist.
    const variant =
      result.variant === "control" || result.variant === "candidate" ? result.variant : "unknown";
    let decision = "no feedback";

    // Skip feedback sometimes — realistic, and it exercises the scorer's
    // 1-day waitForEvent timeout path for messages that never get rated.
    if (Math.random() >= SKIP_FEEDBACK_PROBABILITY) {
      const upProbability = UP_PROBABILITY[variant] ?? DEFAULT_UP_PROBABILITY;
      const up = Math.random() < upProbability;
      decision = up ? "👍" : "👎";

      // feedbackScorer is a separate deferred Inngest run kicked off when
      // record-message completes, and its waitForEvent has no look-back: if
      // the feedback event arrives before that run has actually started and
      // registered its wait, the event is never matched and the score is
      // lost (only surfacing later as a timeout). A short delay can beat
      // deferred-run startup on Inngest Cloud, so wait long enough that the
      // scorer is reliably already waiting before we fire the event.
      await sleep(2000 + Math.random() * 1500);
      const delivered = await sendFeedback(result.messageId, up);
      if (delivered) tally[variant][up ? "up" : "down"]++;
    }

    console.log(`[${variant}] "${truncate(prompt)}" -> ${decision}`);
  }

  // Count failed attempts toward the target too, so a persistently
  // unreachable server can't turn POPULATE_COUNT into an infinite loop.
  if (TARGET_COUNT !== undefined && attempts >= TARGET_COUNT) break;
  await sleep(jitteredInterval(BASE_INTERVAL_MS));
}

printSummary();
process.exit(0);
