// Phase A recon round 6 (decisive): sandboxes are fully hermetic (ENETUNREACH
// everywhere) — the files API is the ONLY way in. This probe uploads the real
// 70.5MB go1.27.0 linux-amd64 tarball from the worker, untars in-VM, and runs
// the offline build/test/gofmt smoke. Answers: size cap? upload speed? total
// bootstrap wall time?
//
//   bun run scripts/probe-upload-toolchain.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../src/inngest/client";
import { config, PROJECT_ROOT } from "../src/config";

const decoder = new TextDecoder();
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";
const TARBALL = join(PROJECT_ROOT, ".cache/go1.27.0.linux-amd64.tar.gz");

void config;

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

async function exec(sbx: Awaited<ReturnType<typeof inngest.sandboxes.create>>, label: string, cmd: string, timeout: string) {
  const t0 = Date.now();
  const r = await sbx.commands.run({ command: ["/bin/sh", "-c", wrap(cmd)], cwd: "/", timeout });
  const out = decoder.decode(r.stdout).trim().replace(new RegExp(`\\n?${SOUT}\\d+\\n?$`), "");
  const err = decoder.decode(r.stderr).trim().replace(new RegExp(`\\n?${SERR}\\d+\\n?$`), "");
  console.log(`\n[${label}] exit=${r.exitCode} (${((Date.now() - t0) / 1000).toFixed(1)}s)${out ? `\n${out}` : ""}${err ? `\n(stderr) ${err}` : ""}`);
  return r.exitCode;
}

async function main() {
  const buf = readFileSync(TARBALL);
  console.log(`tarball: ${(buf.byteLength / 1e6).toFixed(1)} MB`);

  const sbx = await inngest.sandboxes.create({
    name: `omt-tc-${Date.now()}`,
    vcpu: 2,
    memoryMb: 2048,
    runningTimeout: "300s",
  });
  console.log(`sandbox ${sbx.id} (${sbx.status})`);

  try {
    await exec(sbx, "mk-workspace", `mkdir -p /workspace`, "15s");

    const t0 = Date.now();
    try {
      await sbx.files.upload({ path: "/workspace/go.tgz", data: buf });
      console.log(`\n[upload] no throw (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      // S2: throws post-success when server returns string bytesWritten
      console.log(`\n[upload] threw (${((Date.now() - t0) / 1000).toFixed(1)}s): ${e instanceof Error ? e.message : String(e)}`);
    }
    const dl = await sbx.files.download({ path: "/workspace/go.tgz" });
    const head = new Uint8Array(await dl.arrayBuffer()).subarray(0, 4);
    console.log(`[verify] first bytes: ${Array.from(head, (b) => b.toString(16).padStart(2, "0")).join(" ")} (gzip = 1f 8b)`);

    await exec(sbx, "sha256", `sha256sum /workspace/go.tgz`, "60s");
    await exec(sbx, "untar", `mkdir -p /workspace/.gotoolchain && tar -C /workspace/.gotoolchain -xzf /workspace/go.tgz && rm /workspace/go.tgz && /workspace/.gotoolchain/go/bin/go version`, "120s");
    await exec(
      sbx,
      "offline-build-smoke",
      `cd /workspace && printf 'package main\\nimport "fmt"\\nfunc main(){fmt.Println("ok")}\\n' > main.go && ` +
        `printf 'module smoke\\ngo 1.24\\n' > go.mod && ` +
        `export GOCACHE=/workspace/.gocache GOPATH=/workspace/.gopath GOTOOLCHAIN=local HOME=/root PATHS=; ` +
        `/workspace/.gotoolchain/go/bin/go build ./... && echo BUILD-OK && ` +
        `/workspace/.gotoolchain/go/bin/gofmt -l . && echo GOFMT-OK`,
      "180s",
    );
    console.log(`\ntotal probe wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    console.log(`destroy: ${(await sbx.destroy()).status}`);
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
