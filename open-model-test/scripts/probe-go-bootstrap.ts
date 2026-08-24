// Phase A recon round 3: validate the exact Go-bootstrap mechanism the runner
// will use (wget -> untar -> go version), plus the upload-throw/download-ok
// file-op workaround. One sandbox, no model spend.
//
//   bun run scripts/probe-go-bootstrap.ts

import { inngest } from "../src/inngest/client";

const decoder = new TextDecoder();
const GO_VERSION = "1.27.0";
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

function unwrap(text: string, marker: string): string {
  return text.trim().replace(new RegExp(`\\n?${marker}\\d+\\n?$`), "");
}

async function exec(sbx: Awaited<ReturnType<typeof inngest.sandboxes.create>>, label: string, cmd: string, timeout: string) {
  const r = await sbx.commands.run({ command: ["/bin/sh", "-c", wrap(cmd)], cwd: "/", timeout });
  const out = unwrap(decoder.decode(r.stdout), SOUT);
  const err = unwrap(decoder.decode(r.stderr), SERR);
  console.log(`\n[${label}] exit=${r.exitCode}${out ? `\n${out}` : ""}${err ? `\n(stderr) ${err}` : ""}`);
  return { exit: r.exitCode, out, err };
}

async function main() {
  const sbx = await inngest.sandboxes.create({
    name: `omt-goboot-${Date.now()}`,
    vcpu: 2,
    memoryMb: 2048,
    runningTimeout: "300s",
  });
  console.log(`sandbox ${sbx.id} (${sbx.status})`);

  try {
    // /workspace must exist before cwd-scoped execs AND file uploads (S3).
    await exec(sbx, "mk-workspace", `mkdir -p /workspace`, "15s");

    // File ops: upload throws post-success (server returns string bytesWritten);
    // verify catch-then-download sees the content.
    try {
      await sbx.files.upload({ path: "/workspace/seed.txt", data: "seed-content-123" });
      console.log("[upload] no throw (SDK fixed?)");
    } catch (e) {
      console.log(`[upload] threw (expected): ${e instanceof Error ? e.message : String(e)}`);
    }
    const dl = await sbx.files.download({ path: "/workspace/seed.txt" });
    console.log(`[download] -> "${await dl.text()}"`);

    // The real bootstrap: mkdir, wget, untar, version. This is what sb-install-go runs.
    const t0 = Date.now();
    await exec(sbx, "download", `wget -q -O /tmp/go.tgz https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz && ls -la /tmp/go.tgz`, "240s");
    await exec(sbx, "untar", `mkdir -p /workspace/.gotoolchain && tar -C /workspace/.gotoolchain -xzf /tmp/go.tgz && rm /tmp/go.tgz && ls /workspace/.gotoolchain/go/bin`, "120s");
    await exec(sbx, "go-version", `/workspace/.gotoolchain/go/bin/go version`, "30s");
    // Then the per-turn PATH shape: GOCACHE/GOPATH under /workspace, GOTOOLCHAIN=local.
    await exec(
      sbx,
      "go-build-smoke",
      `cd /workspace && printf 'package main\\nfunc main(){}\\n' > main.go && ` +
        `printf 'module smoke\\ngo 1.24\\n' > go.mod && ` +
        `export GOCACHE=/workspace/.gocache GOPATH=/workspace/.gopath GOTOOLCHAIN=local HOME=/root; ` +
        `/workspace/.gotoolchain/go/bin/go build ./... && /workspace/.gotoolchain/go/bin/go test ./... 2>&1 | tail -1; ` +
        `/workspace/.gotoolchain/go/bin/gofmt -l . && echo gofmt-clean`,
      "180s",
    );
    console.log(`\nbootstrap wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    console.log("\ndestroying...");
    console.log(`destroy: ${(await sbx.destroy()).status}`);
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
