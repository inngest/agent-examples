// Isolates the exec 400: raw POST /v2/sandboxes/:id/exec with timeout-format
// variations. Uses the SDK only to create/destroy the sandbox.
//
//   bun run scripts/probe-exec-wire.ts

import { inngest } from "../src/inngest/client";

const decoder = new TextDecoder();
const key = process.env.INNGEST_SIGNING_KEY!;

async function main() {
  const sbx = await inngest.sandboxes.create({
    name: `omt-wire-${Date.now()}`,
    vcpu: 1,
    memoryMb: 1024,
    runningTimeout: "90s",
  });
  console.log(`sandbox ${sbx.id} (${sbx.status})`);

  const url = `https://api.inngest.com/v2/sandboxes/${sbx.id}/exec`;
  const command = ["/bin/sh", "-c", "echo hello-from-exec; uname -m"];

  const bodies: [string, Record<string, unknown>][] = [
    ["ms-string (SDK default)", { command, cwd: "/tmp", timeout: "20000ms" }],
    ["s-string", { command, cwd: "/tmp", timeout: "20s" }],
    ["int-ms", { command, cwd: "/tmp", timeout: 20000 }],
    ["omitted", { command, cwd: "/tmp" }],
  ];

  try {
    for (const [label, body] of bodies) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`\n[${label}] HTTP ${res.status}`);
      console.log(text.slice(0, 300));
      if (res.status === 200) break;
    }
  } finally {
    console.log(`\ndestroy: ${(await sbx.destroy()).status}`);
  }
  void decoder;
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
