// Phase A recon round 4: egress + DNS map. wget failed with "bad address" for
// go.dev — map what actually resolves and connects from inside the sandbox,
// and check whether the nix store already carries a Go toolchain.
//
//   bun run scripts/probe-egress.ts

import { inngest } from "../src/inngest/client";

const decoder = new TextDecoder();
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

async function main() {
  const sbx = await inngest.sandboxes.create({
    name: `omt-egress-${Date.now()}`,
    vcpu: 1,
    memoryMb: 1024,
    runningTimeout: "300s",
  });
  console.log(`sandbox ${sbx.id} (${sbx.status})`);

  const probes: [string, string][] = [
    ["dns-node", `node -e "const d=require('dns');const hosts=['go.dev','dl.google.com','storage.googleapis.com','api.inngest.com','github.com','registry.npmjs.org'];let n=0;for(const h of hosts){d.lookup(h,(e,a)=>{console.log(h,e?('ERR '+e.code):('OK '+a));if(++n===hosts.length)process.exit(0)})}"`],
    ["resolv", `cat /etc/resolv.conf 2>&1; cat /etc/hosts 2>&1; true`],
    ["wget-google", `wget -q -O /dev/null --timeout=10 https://dl.google.com/go/go1.27.0.linux-amd64.tar.gz && echo dl.google.com-OK || echo dl.google.com-FAIL`],
    ["wget-inngest", `wget -q -O /dev/null --timeout=10 https://api.inngest.com/v1/health 2>&1 && echo api.inngest.com-OK || echo api.inngest.com-FAIL`],
    ["node-fetch-go", `node -e "fetch('https://go.dev/dl/',{method:'HEAD'}).then(r=>console.log('go.dev',r.status)).catch(e=>console.log('go.dev ERR',e.cause?.code??e.message))"`],
    ["nix-store", `ls /nix/store 2>/dev/null | head -40; ls /nix/store/*go*/bin 2>/dev/null | head; true`],
    ["nix-go", `command -v go gofmt; find / -maxdepth 4 -name 'go' -type f 2>/dev/null | head -5; true`],
  ];

  try {
    for (const [label, cmd] of probes) {
      try {
        const r = await sbx.commands.run({ command: ["/bin/sh", "-c", wrap(cmd)], cwd: "/", timeout: "45s" });
        const out = decoder.decode(r.stdout).trim().replace(new RegExp(`\\n?${SOUT}\\d+\\n?$`), "");
        const err = decoder.decode(r.stderr).trim().replace(new RegExp(`\\n?${SERR}\\d+\\n?$`), "");
        console.log(`\n[${label}] exit=${r.exitCode}${out ? `\n${out}` : ""}${err ? `\n(stderr) ${err}` : ""}`);
      } catch (e) {
        console.log(`\n[${label}] THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    console.log(`\ndestroy: ${(await sbx.destroy()).status}`);
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
