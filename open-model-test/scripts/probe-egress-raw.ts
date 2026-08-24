// Phase A recon round 5: is there ANY egress? DNS is dead network-wide, but we
// are root — if raw TCP to public IPs works, /etc/hosts + hardcoded IPs could
// bypass DNS. Decides between "bootstrap via /etc/hosts" and "upload toolchain
// through the files API".
//
//   bun run scripts/probe-egress-raw.ts

import { inngest } from "../src/inngest/client";

const decoder = new TextDecoder();
const SOUT = "__OMT_STDOUT__";
const SERR = "__OMT_STDERR__";

function wrap(cmd: string): string {
  return `{ ${cmd} ; } ; __rc=$?; printf '\\n${SOUT}%s\\n' "$__rc"; printf '\\n${SERR}%s\\n' "$__rc" >&2; exit "$__rc"`;
}

async function main() {
  const sbx = await inngest.sandboxes.create({
    name: `omt-raw-${Date.now()}`,
    vcpu: 1,
    memoryMb: 1024,
    runningTimeout: "300s",
  });
  console.log(`sandbox ${sbx.id} (${sbx.status})`);

  const probes: [string, string][] = [
    // go.dev / dl.google.com share Google frontends; 142.250.190.14 is a
    // known go.dev A-record; 1.1.1.1:443 and 8.8.8.8:53 probe transit generally.
    ["tcp-8888-dns", `node -e "const net=require('net');const s=net.connect(53,'8.8.8.8');s.setTimeout(4000);s.on('connect',()=>{console.log('TCP 8.8.8.8:53 OK');s.end()});s.on('timeout',()=>{console.log('TCP 8.8.8.8:53 TIMEOUT');s.destroy()});s.on('error',e=>console.log('TCP 8.8.8.8:53 ERR',e.code))"`],
    ["tcp-1111-443", `node -e "const net=require('net');const s=net.connect(443,'1.1.1.1');s.setTimeout(4000);s.on('connect',()=>{console.log('TCP 1.1.1.1:443 OK');s.end()});s.on('timeout',()=>{console.log('TCP 1.1.1.1:443 TIMEOUT');s.destroy()});s.on('error',e=>console.log('TCP 1.1.1.1:443 ERR',e.code))"`],
    ["tcp-godev-443", `node -e "const net=require('net');const s=net.connect(443,'142.250.190.14');s.setTimeout(4000);s.on('connect',()=>{console.log('TCP go.dev-IP:443 OK');s.end()});s.on('timeout',()=>{console.log('TCP go.dev-IP:443 TIMEOUT');s.destroy()});s.on('error',e=>console.log('TCP go.dev-IP:443 ERR',e.code))"`],
    ["hosts-write", `printf '142.250.190.14 go.dev\\n' >> /etc/hosts && tail -2 /etc/hosts`],
    ["wget-after-hosts", `wget -q -O /dev/null --timeout=8 https://go.dev/dl/ && echo hosts-bypass-OK || echo hosts-bypass-FAIL`],
  ];

  try {
    for (const [label, cmd] of probes) {
      try {
        const r = await sbx.commands.run({ command: ["/bin/sh", "-c", wrap(cmd)], cwd: "/", timeout: "30s" });
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
