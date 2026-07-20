# From fragile to durable, edit by edit

How [`stage-1-fragile`](./stage-1-fragile) becomes [`stage-2-durable`](./stage-2-durable).
Nothing about the tool or the prompt changes — only the orchestration. Diff the
two folders to see the whole thing at once; this is the guided version.

The moves:

1. Add an Inngest client.
2. Wrap the model call in a durable step.
3. Dispatch each tool through `step.invoke`.
4. Give each tool its own retried Inngest function.
5. Wrap the orchestrator as an Inngest function.
6. Wire the server to fire an event instead of blocking on the loop.

---

## 1. Add the Inngest client

New file — `src/inngest/client.ts`:

```ts
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "durable-agent" });
```

## 2. Wrap the model call in a step — `src/agent.ts`

Add the imports and a `Step` type, and change `runAgent` to take a `step`:

```diff
 import Anthropic from "@anthropic-ai/sdk";
+import type { GetStepTools } from "inngest";
-import { executeTool, toolDefinitions } from "./tools";
+import { toolDefinitions } from "./tools";
+import type { inngest } from "./inngest/client";
 ...
+type Step = GetStepTools<typeof inngest>;
+
-export async function runAgent(prompt: string): Promise<Anthropic.ContentBlock[]> {
+export async function runAgent(step: Step, prompt: string): Promise<Anthropic.ContentBlock[]> {
```

Memoize the model call so a later failure never re-runs it:

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

## 3. Tool dispatch becomes `step.invoke` — `src/agent.ts`

Instead of running the tool inline, invoke its Inngest function by name.
`step.invoke` runs the tool as its own memoized step and returns the result
directly — no event correlation, no `toolCallId` matching, no timeout to tune.
`Promise.all` fans out multiple tool calls in one turn:

```diff
-    // No try/catch — an uncaught tool failure kills the whole run.
-    const toolResults: Anthropic.ToolResultBlockParam[] = [];
-    for (const block of response.content) {
-      if (block.type !== "tool_use") continue;
-      const result = await executeTool(block.name, block.input);
-      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
-    }
+    // Invoke each requested tool as its own durable step.
+    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
+      response.content
+        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
+        .map(async (block, i) => {
+          const fn = toolFunctions[block.name];
+          if (!fn) throw new Error(`Unknown tool: ${block.name}`);
+
+          const content = await step.invoke(`run-${block.name}-${i}`, {
+            function: fn,
+            // toolCallId flows through as the idempotency key (see tools.ts).
+            data: { input: block.input, toolCallId: block.id },
+          });
+
+          return { type: "tool_result", tool_use_id: block.id, content };
+        }),
+    );
```

`toolFunctions[block.name]` is the name-keyed record from step 4.

## 4. Each tool gets its own retried function

New file — `src/inngest/tool-functions.ts`. It's a record keyed by tool name so
the agent loop can resolve each tool for `step.invoke`. The function returns its
`step.run` result directly — `step.invoke` hands that back to the caller, so no
completion event is needed:

```ts
import { inngest } from "./client";
import { executeTool, toolDefinitions } from "../tools";

// One Inngest function per declared tool, keyed by name — no tool name hardcoded.
export const toolFunctions = Object.fromEntries(
  toolDefinitions.map((def) => [
    def.name,
    inngest.createFunction(
      { id: `tool-${def.name}`, retries: 5, triggers: [{ event: `tool/${def.name}.requested` }] },
      async ({ event, step }) =>
        step.run(`tool/${def.name}`, () =>
          // toolCallId rides along as the tool's idempotency key.
          executeTool(def.name, event.data.input, event.data.toolCallId),
        ),
    ),
  ]),
);
```

## 5. Wrap the orchestrator as a function

New file — `src/inngest/functions.ts`:

```ts
import { inngest } from "./client";
import { runAgent } from "../agent";

export const runAgentFn = inngest.createFunction(
  { id: "run-agent", triggers: [{ event: "agent/run.requested" }] },
  async ({ event, step }) => {
    return runAgent(step, event.data.prompt);
  },
);
```

## 6. Wire the server — `src/index.ts`

Swap the direct import for the Inngest pieces. This example registers functions
over [Connect](https://www.inngest.com/docs/setup/connect) — an outbound
WebSocket from the worker — so there's no inbound `/api/inngest` serve endpoint:

```diff
-import { runAgent } from "./agent";
+import { connect, ConnectionState } from "inngest/connect";
+import { inngest } from "./inngest/client";
+import { runAgentFn } from "./inngest/functions";
+import { toolFunctions } from "./inngest/tool-functions";
+
+// step.invoke routes to a served function, so every tool function is registered
+// alongside the orchestrator. toolFunctions is a name-keyed record now.
+const functions = [runAgentFn, ...Object.values(toolFunctions)];
+await connect({ apps: [{ client: inngest, functions }] });
```

The agent route becomes fire-and-forget:

```diff
       async POST(req) {
         const { prompt } = await req.json();
-        const content = await runAgent(prompt);
-        return Response.json({ content });
+        const { ids } = await inngest.send({ name: "agent/run.requested", data: { prompt } });
+        return Response.json({ eventId: ids[0] });
       },
```

And drop the stage-1 `error()` handler — the agent route no longer throws
synchronously back to the caller:

```diff
-  // Overrides Bun's dev-mode HTML error overlay with a clean one-liner.
-  error(error) {
-    console.error(`agent run failed: ${error.message}`);
-    return Response.json({ error: error.message }, { status: 500 });
-  },
```

---

That's the whole change. Run both stages a few times (see each stage's README) to
feel the difference: the mock charge is deliberately flaky, so stage 1 loses the
run whenever the tool fails; stage 2 retries just the tool and resumes.
