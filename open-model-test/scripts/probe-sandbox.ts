// Phase A recon (demo migration): one throwaway sandbox via the DIRECT client
// (no function, no model spend), probing the fixed beta image for everything
// the Go-bootstrap plan depends on. Prints raw findings; destroys on exit.
//
//   bun run probe:sandbox
//
// Image recon so far (2026-08-24): NixOS x86_64, kernel 6.18, no /etc/os-release;
// /workspace does NOT exist (a cwd pointing there 400s with invalid_field_format —
// create it first, cwd "/" for bootstrap commands); no Go toolchain (expected).
//
// SDK quirk (4.18.1, also latest): the server omits empty stdout/stderr fields,
// but the client schema marks both required — any exec leaving a stream empty
// throws "Invalid sandbox exec result at <stream>: Required". The durable
// step.sandbox path routes through the same parse (durable.js executeSandboxOperation),
// so EVERY command must emit on both streams. wrap() appends stream markers and
// re-exits with the real code; unwrap() strips them.

import { inngest } from "../src/inngest/client";

const decoder = new TextDecoder();
const NAME = `omt-probe-${Date.now()}`;
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

function unwrap(text: string, marker: string): string {
  const re = new RegExp(`\\n?${marker}\\d+\\n?$`);
  return text.replace(re, "").replace(new RegExp(`^\\n${marker}\\d+\\n$`), "");
}

async function main() {
  console.log(`creating sandbox ${NAME} (vcpu 2, 2048 MB)...`);
  const sbx = await inngest.sandboxes.create({
    name: NAME,
    vcpu: 2,
    memoryMb: 2048,
    runningTimeout: "120s",
  });
  console.log(`created: id=${sbx.id} status=${sbx.status} image=${sbx.imageRef} vpc=${sbx.vpcId}`);

  const probes: [string, string][] = [
    ["mk-workspace", `mkdir -p /workspace && touch /workspace/.w && rm /workspace/.w && echo root-writable`],
    ["downloaders", `command -v curl; command -v wget; command -v node; command -v tar; command -v gzip; true`],
    ["node", `node --version; npm --version; true`],
    ["whoami", `whoami; echo HOME=$HOME; id; true`],
    ["disk", `df -h / /tmp; true`],
    ["net-go", `getent hosts go.dev | head -1; getent hosts dl.google.com | head -1; true`],
    ["fetch-head", `curl -sI --max-time 10 https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | head -3 || node -e "fetch('https://go.dev/dl/go1.27.0.linux-amd64.tar.gz',{method:'HEAD'}).then(r=>console.log('node-fetch',r.status))"`],
    ["file-upload", `true`],
  ];

  try {
    for (const [label, cmd] of probes) {
      try {
        const r = await sbx.commands.run({
          command: ["/bin/sh", "-c", wrap(cmd)],
          cwd: "/",
          timeout: "30s",
        });
        const out = unwrap(decoder.decode(r.stdout).trim(), SOUT);
        const err = unwrap(decoder.decode(r.stderr).trim(), SERR);
        console.log(`\n[${label}] exit=${r.exitCode}`);
        if (out) console.log(out);
        if (err) console.log(`(stderr) ${err}`);
      } catch (e) {
        const extra =
          e && typeof e === "object" && "code" in e
            ? ` code=${(e as { code?: string }).code} status=${(e as { status?: number }).status}`
            : "";
        console.log(`\n[${label}] THREW${extra}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Direct-client file ops (used by the runner for seeding):
    try {
      const up = await sbx.files.upload({ path: "/workspace/probe.txt", data: "hello upload" });
      console.log(`\n[upload] ${JSON.stringify(up)}`);
      const dl = await sbx.files.download({ path: "/workspace/probe.txt" });
      console.log(`[download] ${await dl.text()}`);
    } catch (e) {
      console.log(`\n[file-ops] THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    console.log("\ndestroying...");
    const res = await sbx.destroy();
    console.log(`destroy: ${res.status}`);
  }
}

main().catch((e) => {
  console.error(`PROBE FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
