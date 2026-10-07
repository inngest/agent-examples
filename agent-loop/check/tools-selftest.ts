// pnpm check:tools — path guard + store semantics for the agent's tools.
// Read-only against workspace/ (the local store is only asked to resolve paths).
import { executeTool } from "../src/inngest/tools.js";
import { localFsStore, memoryStore } from "../src/lib/file-store.js";
import { templateSource } from "../src/lib/backend.js";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const call = (store: Parameters<typeof executeTool>[0], name: string, args: unknown) =>
  executeTool(store, name, JSON.stringify(args));

const bad = ["../check/run-check.ts", "/etc/passwd", "a/../../x.ts", "..", "src/../../x.ts"];
for (const [label, mk] of [["fs", () => localFsStore], ["memory", () => memoryStore({ "semver.ts": "export {};\n" })]] as const) {
  for (const p of bad) {
    const r = await call(mk(), "read_file", { path: p });
    ok(/^error: path .* outside src\/ or invalid/.test(r.result), `${label}: read_file ${p} rejected`);
    const w = await call(mk(), "write_file", { path: p, content: "export {};" });
    ok(/^error: path .* outside src\/ or invalid/.test(w.result), `${label}: write_file ${p} rejected`);
  }
}

// memory store semantics
const m = memoryStore({ "semver.ts": templateSource() });
ok((await call(m, "list_files", {})).result === "semver.ts", "memory: list_files");
ok((await call(m, "read_file", { path: "nope.ts" })).result.startsWith("error: no such file"), "memory: read missing file");
ok((await call(m, "write_file", { path: "notes.md", content: "x" })).result === "error: only .ts files can be written", "memory: non-.ts write rejected");
ok((await call(m, "write_file", { path: "sub/x.ts", content: "x" })).result.startsWith("error: directory for"), "memory: write into missing dir rejected");
ok((await call(m, "write_file", { path: "big.ts", content: "a".repeat(51 * 1024) })).result.startsWith("error: file too large"), "memory: 50KB cap on write");
ok((await call(m, "edit_file", { path: "semver.ts", old_string: "zzz", new_string: "y" })).result.startsWith("error: old_string not found"), "memory: edit no match");
ok((await call(m, "edit_file", { path: "semver.ts", old_string: 'throw new Error("not implemented");', new_string: "return 1;" })).result.includes("matches"), "memory: edit ambiguous match rejected");

const w = await call(m, "write_file", { path: "semver.ts", content: 'export function IsValid(v: string): boolean {\n  return v.length > 0;\n}\n' });
ok(w.result.includes("typecheck: ok"), "memory: write_file typechecks ok");
ok(w.changed?.["semver.ts"]?.includes("v.length > 0") === true, "memory: write_file returns changed contents");
const e = await call(m, "edit_file", { path: "semver.ts", old_string: "return v.length > 0;", new_string: "return v.length > 'x';" });
ok(e.result.includes("typecheck errors") && e.result.includes("src/semver.ts"), "memory: type error reported by temp-dir tsc");
ok(e.changed?.["semver.ts"]?.includes("'x'") === true, "memory: edit_file returns changed contents");
ok((await call(m, "read_file", { path: "semver.ts" })).result.includes("'x'"), "memory: store reflects the edit");
const f = await call(m, "finish_attempt", { summary: "done" });
ok(f.finished === "done" && f.changed === undefined, "memory: finish_attempt has no changed");
// multi-file: .ts specifiers typecheck; .js ones are rejected (node type stripping in the sandbox can't resolve them)
const mf = memoryStore({ "semver.ts": 'import { two } from "./util.ts";\nexport const x: number = two();\n', "util.ts": "export const two = (): number => 2;\n" });
ok((await call(mf, "typecheck", {})).result === "typecheck passed: no errors", "memory: .ts import specifier typechecks");
const js = await call(mf, "edit_file", { path: "semver.ts", old_string: '"./util.ts"', new_string: '"./util.js"' });
ok(js.result.includes("typecheck errors") && js.result.includes('must name the .ts file: "./util.ts"'), "memory: .js import specifier rejected");
// local store never returns `changed`
ok((await call(localFsStore, "finish_attempt", { summary: "s" })).changed === undefined, "fs: no changed field");

process.exit(failures ? 1 : 0);
