# Video beat playbook

Order of beats for the recording. Stage 1 files (`agent.ts`, `index.ts`) are what's
on screen at the start; each beat pastes a chunk of the already-written stage 2
files (`agent.stage2.ts`, `index.stage2.ts`, `inngest/*.ts`) into them live.

---

## Beat 0 — Baseline: stage 1 running, then failing

```sh
bun run dev
```

```sh
bun run agent
```

Shows a clean success response. Now break it:

```sh
bun run kill-switch:on
bun run agent
```

`500`, single clean error line in the server log. Say the line: an uncaught tool
failure kills the whole run — every prior message and tool result in that loop
is gone. That's the problem stage 2 fixes.

```sh
bun run kill-switch:off
```

Stop the stage 1 server (`Ctrl-C`) before Beat 7.

---

## Beat 1 — Install Inngest

```sh
bun add inngest
```

New file — `src/inngest/client.ts`:

```ts
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "duable-agent" });
```

---

## Beat 2 — Duplicate the agent loop, wrap the model call in a step

Copy `src/agent.ts` → `src/agent.stage2.ts`. Paste these edits into the copy.

Add imports:

```ts
import type { GetStepTools } from "inngest";
import type { inngest } from "./inngest/client";
```

Add the step type, just above `runAgent`:

```ts
type Step = GetStepTools<typeof inngest>;
```

Change the signature:

```diff
-export async function runAgent(prompt: string): Promise<Anthropic.ContentBlock[]> {
+export async function runAgent(step: Step, prompt: string): Promise<Anthropic.ContentBlock[]> {
```

Wrap the model call in a step:

```diff
-    const response = await client.messages.create({
-      model: MODEL,
-      max_tokens: 1024,
-      tools: toolDefinitions,
-      messages,
-    });
+    // Cast: step.run JSON-round-trips the result, but it's really a Message.
+    const response = (await step.run("call-model", () =>
+      client.messages.create({
+        model: MODEL,
+        max_tokens: 1024,
+        tools: toolDefinitions,
+        messages,
+      }),
+    )) as Anthropic.Message;
```

---

## Beat 3 — Tool dispatch becomes trigger-and-wait

This is the core beat: the agent decides which tool to call, and dispatch fires
an event and waits for the reply — instead of running the tool inline.

```diff
-    // No try/catch — an uncaught tool failure kills the whole run.
-    const toolResults: Anthropic.ToolResultBlockParam[] = [];
-    for (const block of response.content) {
-      if (block.type !== "tool_use") continue;
-      const result = await executeTool(block.name, block.input);
-      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
-    }
+    // Trigger the tool's own Inngest function, then wait for it to reply.
+    const toolResults: Anthropic.ToolResultBlockParam[] = [];
+    for (const block of response.content) {
+      if (block.type !== "tool_use") continue;
+
+      await step.sendEvent(`trigger-${block.name}`, {
+        name: `tool/${block.name}.requested`,
+        data: { toolCallId: block.id, input: block.input },
+      });
+
+      const completion = await step.waitForEvent(`wait-${block.name}`, {
+        event: `tool/${block.name}.completed`,
+        timeout: "5m",
+        if: `async.data.toolCallId == ${JSON.stringify(block.id)}`,
+      });
+
+      if (!completion) {
+        throw new Error(`tool ${block.name} did not complete within 5m`);
+      }
+
+      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: completion.data.result });
+    }
```

Drop the now-unused `executeTool` import — only `toolDefinitions` is still needed:

```diff
-import { executeTool, toolDefinitions } from "./tools";
+import { toolDefinitions } from "./tools";
```

---

## Beat 4 — Give the tool its own Inngest function

New file — `src/inngest/tool-functions.ts`:

```ts
import { inngest } from "./client";
import { executeTool, toolDefinitions } from "../tools";

// One Inngest function per declared tool — no tool name hardcoded here.
export const toolFunctions = toolDefinitions.map((def) =>
  inngest.createFunction(
    { id: `tool-${def.name}`, retries: 5, triggers: [{ event: `tool/${def.name}.requested` }] },
    async ({ event }) => {
      const result = await executeTool(def.name, event.data.input);
      await inngest.send({
        name: `tool/${def.name}.completed`,
        data: { toolCallId: event.data.toolCallId, result },
      });
    },
  ),
);
```

Say the line: `executeTool` didn't move or change — it's the same registry from
`tools.ts`, just called from inside a durable, independently-retried function now.

---

## Beat 5 — Wrap the orchestrator itself as an Inngest function

New file — `src/inngest/functions.ts`:

```ts
import { inngest } from "./client";
import { runAgent } from "../agent.stage2";

export const runAgentFn = inngest.createFunction(
  { id: "run-agent", triggers: [{ event: "agent/run.requested" }] },
  async ({ event, step }) => {
    return runAgent(step, event.data.prompt);
  },
);
```

---

## Beat 6 — Wire the server: send an event instead of calling the loop directly

Copy `src/index.ts` → `src/index.stage2.ts`. Paste these edits into the copy.

Swap the import:

```diff
-import { runAgent } from "./agent";
+import { serve } from "inngest/bun";
+import { inngest } from "./inngest/client";
+import { runAgentFn } from "./inngest/functions";
+import { toolFunctions } from "./inngest/tool-functions";
```

Swap the handler body:

```diff
       async POST(req) {
         const { prompt } = await req.json();
-        const content = await runAgent(prompt);
-        return Response.json({ content });
+        const { ids } = await inngest.send({ name: "agent/run.requested", data: { prompt } });
+        return Response.json({ eventId: ids[0] });
       },
```

Add the Inngest route, right after `/api/kill-switch`:

```ts
    "/api/inngest": serve({ client: inngest, functions: [runAgentFn, ...toolFunctions] }),
```

Delete the `error()` handler block — the agent route is fire-and-forget now, so
there's nothing left that throws synchronously back to the caller:

```diff
-  // Overrides Bun's dev-mode HTML error overlay with a clean one-liner.
-  error(error) {
-    console.error(`agent run failed: ${error.message}`);
-    return Response.json({ error: error.message }, { status: 500 });
-  },
```

---

## Beat 7 — Run stage 2 side by side with the Inngest Dev Server

```sh
bun run src/index.stage2.ts
```

```sh
bun run inngest
```

Open the dashboard at `http://localhost:8288`.

```sh
bun run agent
```

Response is now just `{"eventId":"..."}` — point out the dashboard: a
`run-agent` run appears, and inside it a linked `tool-charge_credit_card` run.
Two functions, two separately-retried units of work, one demo.

---

## Beat 8 — Break it again, but now it heals itself

```sh
bun run kill-switch:on
bun run agent
```

Watch the dashboard: `tool-charge_credit_card` fails once or twice (its own
`retries: 5`), auto-reverts the kill switch, then succeeds. `run-agent` never
restarts and never re-calls the model — it was just sitting in
`step.waitForEvent`. The final run output shows the completed charge.

Contrast with Beat 0: same failure, but nothing was lost this time.

```sh
bun run kill-switch:off
```
