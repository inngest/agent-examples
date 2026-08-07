// Local traffic generator for phase-3-multiturn-evals. Plays a fixed,
// deterministic set of support-ticket scenarios (`SCENARIOS` below) once
// through the running app, so the Inngest experiment view and the DuckDB
// golden dataset fill up without a human pasting tickets through the UI
// turn by turn.
//
// Unlike the old generic-chat version of this script, feedback here is no
// longer synthetic/random — it's a deterministic comparison against each
// scenario turn's `expected` category/urgency. Each reply is parsed with
// parseTriage() and compared: a match sends 👍, a mismatch (or a reply that
// didn't even parse as valid triage JSON) sends 👎. This is what lets the
// summary report an actual label-match rate per variant instead of just a
// vibe.
//
// Scenarios play in order (not randomly), each turn by turn: the running
// transcript (`history`) is sent as `messages` on every request, and the
// `conversationId` returned by the first reply is reused for the rest of
// that scenario, mirroring what the real UI does. If any turn fails, the
// rest of that scenario is abandoned and the next one starts fresh.
//
// Run alongside `bun run dev`:
//   bun run populate

import { parseTriage, type Category, type Urgency } from "../src/triage";

const BASE_URL =
  process.env.POPULATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type ExpectedTriage = { category: Category; urgency: Urgency };
type ScenarioTurn = { message: string; expected: ExpectedTriage };
type Scenario = ScenarioTurn[];

// ~20 scripted tickets covering: single-turn quickies across categories and
// urgencies; multiturn escalations where a later turn raises the urgency of
// an already-triaged ticket; multiturn category flips where a later turn
// reveals the ticket is actually a different category than it first looked;
// and angry/frustrated tickets to exercise the judge's sentiment/urgency
// signals against real frustration, not just neutral wording. Each turn's
// `expected` is what the *entire ticket, re-triaged so far* should resolve
// to after that turn — matching TRIAGE_SYSTEM_PROMPT's "re-triage the whole
// ticket on every turn" instruction.
const SCENARIOS: Scenario[] = [
  // --- single-turn quickies, across categories/urgencies ---
  [
    {
      message: "How do I export my data to CSV? I can't find the button anywhere.",
      expected: { category: "how-to", urgency: "low" },
    },
  ],
  [
    {
      message: "I was charged twice for my monthly subscription this billing cycle, can you check?",
      expected: { category: "billing", urgency: "low" },
    },
  ],
  [
    {
      message: "It would be great if you added dark mode to the mobile app at some point.",
      expected: { category: "feature-request", urgency: "low" },
    },
  ],
  [
    {
      message: "I think someone else logged into my account — I see login history from a country I've never visited.",
      expected: { category: "account", urgency: "high" },
    },
  ],
  [
    {
      message: "Quick question — where do I change my email notification preferences?",
      expected: { category: "how-to", urgency: "low" },
    },
  ],
  [
    {
      message: "Can you add a keyboard shortcut for archiving items? Would save a lot of clicks.",
      expected: { category: "feature-request", urgency: "low" },
    },
  ],
  [
    {
      message: "My invoice from last month shows a different amount than what's in my plan details.",
      expected: { category: "billing", urgency: "medium" },
    },
  ],
  [
    {
      message: "I can't log in at all, it just says 'invalid credentials' even after I reset my password.",
      expected: { category: "account", urgency: "medium" },
    },
  ],

  // --- multiturn escalations: urgency should rise as impact is revealed ---
  [
    {
      message: "The export feature is timing out for me when I try to download a report.",
      expected: { category: "bug", urgency: "low" },
    },
    {
      message: "Actually this is happening to everyone on my team now, and we have a board meeting demo in an hour that needs this report.",
      expected: { category: "bug", urgency: "critical" },
    },
  ],
  [
    {
      message: "I'm seeing occasional slow page loads on the dashboard, maybe once or twice a day.",
      expected: { category: "bug", urgency: "low" },
    },
    {
      message: "Update: it just went down completely for our whole company, nobody can access anything right now.",
      expected: { category: "bug", urgency: "critical" },
    },
  ],
  [
    {
      message: "Small thing — the search bar takes a second longer than usual to return results.",
      expected: { category: "bug", urgency: "low" },
    },
    {
      message: "This has now been down for 3 hours and it's blocking our entire customer support queue.",
      expected: { category: "bug", urgency: "critical" },
    },
  ],
  [
    {
      message: "I noticed my storage usage looks higher than expected this month.",
      expected: { category: "billing", urgency: "low" },
    },
    {
      message: "I just realized we're about to hit our hard cap and lose write access in the next few hours, we need this resolved today.",
      expected: { category: "billing", urgency: "high" },
    },
  ],

  // --- multiturn category flips ---
  [
    {
      message: "How do I set up two-factor authentication on my account?",
      expected: { category: "how-to", urgency: "low" },
    },
    {
      message: "I followed the steps but the app just crashes every time I tap 'enable 2FA' — it never actually turns on.",
      expected: { category: "bug", urgency: "medium" },
    },
  ],
  [
    {
      message: "How can I upgrade my plan to get more seats?",
      expected: { category: "how-to", urgency: "low" },
    },
    {
      message: "I upgraded like you said, but I was charged for 20 seats when I only selected 5.",
      expected: { category: "billing", urgency: "medium" },
    },
  ],
  [
    {
      message: "Is there a way to bulk-delete old projects from my workspace?",
      expected: { category: "how-to", urgency: "low" },
    },
    {
      message: "Turns out that feature deleted my active project too, along with ones I wanted to keep — can that be recovered?",
      expected: { category: "bug", urgency: "high" },
    },
  ],

  // --- angry / frustrated tone ---
  [
    {
      message: "THIS IS THE THIRD TIME I'VE EMAILED ABOUT THIS AND NO ONE HAS RESPONDED. My account was suspended for no reason and I'm losing business every day this drags on!!",
      expected: { category: "account", urgency: "critical" },
    },
  ],
  [
    {
      message: "I am absolutely done with this. Your billing system charged my card FIVE separate times this week and support keeps ignoring me. Fix this now or I'm disputing every charge with my bank.",
      expected: { category: "billing", urgency: "critical" },
    },
  ],
  [
    {
      message: "Unacceptable. The app has been crashing on every single launch since your last update and I have work I need to get done TODAY.",
      expected: { category: "bug", urgency: "high" },
    },
  ],
  [
    {
      message: "I'm furious — I was told this bug was fixed two weeks ago and it just happened AGAIN, wiping out an hour of unsaved work.",
      expected: { category: "bug", urgency: "high" },
    },
  ],
  [
    {
      message: "Ridiculous that there's still no way to export a simple report after I've asked for this feature for months. Extremely disappointed.",
      expected: { category: "feature-request", urgency: "medium" },
    },
  ],

  // --- a couple more quickies to round things out ---
  [
    {
      message: "What's the difference between the Pro and Team plans?",
      expected: { category: "how-to", urgency: "low" },
    },
  ],
  [
    {
      message: "Could you add an API endpoint for bulk-updating tags? We're doing it one-by-one right now and it's painful.",
      expected: { category: "feature-request", urgency: "low" },
    },
  ],
];

const BASE_INTERVAL_MS = Number(process.env.POPULATE_INTERVAL_MS ?? 4000);

// Only accept a positive integer; anything else (unset, garbage, 0, negative)
// falls back to unbounded (all scenarios) rather than silently becoming
// `>= NaN`, which would behave unpredictably despite the user asking for a
// bound.
function parseScenarioCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.log(`ignoring invalid POPULATE_COUNT=${JSON.stringify(raw)}; expected a positive integer`);
    return undefined;
  }
  return parsed;
}

// POPULATE_COUNT is a count of *scenarios* to play (not attempts) — clamped
// against SCENARIOS.length rather than interpreted as an attempt-count
// cutoff, since this script no longer loops forever.
const SCENARIO_COUNT = Math.min(parseScenarioCount(process.env.POPULATE_COUNT) ?? SCENARIOS.length, SCENARIOS.length);

type ChatResult = { reply: string; variant?: string; messageId: string; conversationId: string };

let totalTurns = 0;
let repliesReceived = 0;
let feedbackSent = 0;
let validJsonCount = 0;
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

async function sendChat(
  messages: ChatMessage[],
  conversationId: string | undefined,
): Promise<ChatResult | undefined> {
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(conversationId ? { messages, conversationId } : { messages }),
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
  console.log(`scenarios played:   ${Math.min(SCENARIO_COUNT, SCENARIOS.length)}`);
  console.log(`total turns:        ${totalTurns}`);
  console.log(`successful replies: ${repliesReceived}`);
  console.log(
    `valid-JSON rate:    ${repliesReceived > 0 ? ((validJsonCount / repliesReceived) * 100).toFixed(1) : "0.0"}% (${validJsonCount}/${repliesReceived})`,
  );
  console.log(`feedback sent:      ${feedbackSent}`);
  for (const variant of ["control", "candidate", "unknown"] as const) {
    const { up, down } = tally[variant];
    const total = up + down;
    const rate = total > 0 ? ((up / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${variant}: ${up} match / ${down} mismatch (${rate}%)`);
  }
}

process.on("SIGINT", () => {
  printSummary();
  process.exit(0);
});

// Plays one scenario turn by turn. Returns normally once the scenario is
// exhausted; abandons the rest of the scenario (rather than retrying) the
// moment a turn fails, so one bad request doesn't wedge the loop.
async function runScenario(index: number, scenario: Scenario): Promise<void> {
  const history: ChatMessage[] = [];
  let conversationId: string | undefined;

  for (let turn = 0; turn < scenario.length; turn++) {
    const { message, expected } = scenario[turn];
    const label = `scenario #${index} turn ${turn + 1}/${scenario.length}`;
    history.push({ role: "user", content: message });

    const result = await sendChat(history, conversationId);
    totalTurns++;

    if (!result) {
      console.log(`${label} "${truncate(message)}" -> failed; abandoning scenario`);
      return;
    }

    conversationId = result.conversationId;
    history.push({ role: "assistant", content: result.reply });
    repliesReceived++;

    // The server only ever returns "control" or "candidate", but don't trust
    // that at the type level — an unrecognized value falls back to the
    // existing "unknown" bucket instead of being force-cast into a tally key
    // that doesn't exist.
    const variant =
      result.variant === "control" || result.variant === "candidate" ? result.variant : "unknown";

    // The deterministic simulated human: 👍 iff the model's parsed triage
    // matches the expected category+urgency for this point in the ticket,
    // 👎 otherwise — including whenever the reply didn't parse as valid
    // triage JSON at all, since `!!parsed` is false in that case.
    const parsed = parseTriage(result.reply);
    if (parsed) validJsonCount++;
    const matched = !!parsed && parsed.category === expected.category && parsed.urgency === expected.urgency;
    const got = parsed ? `{${parsed.category}, ${parsed.urgency}}` : "(invalid JSON)";

    // feedbackScorer is a separate deferred Inngest run kicked off when
    // record-message completes, and its waitForEvent has no look-back: if
    // the feedback event arrives before that run has actually started and
    // registered its wait, the event is never matched and the score is
    // lost (only surfacing later as a timeout). A short delay can beat
    // deferred-run startup on Inngest Cloud, so wait long enough that the
    // scorer is reliably already waiting before we fire the event.
    await sleep(2000 + Math.random() * 1500);
    const delivered = await sendFeedback(result.messageId, matched);
    if (delivered) tally[variant][matched ? "up" : "down"]++;

    console.log(
      `[${variant}] ${label} "${truncate(message)}" expected {${expected.category}, ${expected.urgency}} got ${got} -> ${matched ? "👍" : "👎"}`,
    );

    if (turn < scenario.length - 1) {
      await sleep(jitteredInterval(BASE_INTERVAL_MS));
    }
  }
}

for (let i = 0; i < SCENARIO_COUNT; i++) {
  await runScenario(i, SCENARIOS[i]);
  if (i < SCENARIO_COUNT - 1) {
    await sleep(jitteredInterval(BASE_INTERVAL_MS));
  }
}

printSummary();
process.exit(0);
