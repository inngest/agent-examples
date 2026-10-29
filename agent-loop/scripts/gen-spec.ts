// Writes data/spec.txt: the documentation of golang.org/x/mod/semver (package
// overview + every exported function), the spec a human porter would read.
// No function bodies. It comes from the same module version that generated the
// test cases: golden/go.mod pins it, go.sum verifies it, and data/meta.json
// records it; this refuses to write if they disagree.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, REPO_ROOT } from "../src/lib/paths.js";

const golden = path.join(REPO_ROOT, "golden");
const go = (...args: string[]) =>
  execFileSync("go", args, { cwd: golden, encoding: "utf8", env: { ...process.env, GOFLAGS: "-mod=readonly" } });

const version = go("list", "-m", "-f", "{{.Version}}", "golang.org/x/mod").trim();
const casesVersion = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "meta.json"), "utf8")).xModVersion;
if (version !== casesVersion) {
  console.error(`golden/go.mod resolves golang.org/x/mod ${version}, but the cases were generated with ${casesVersion}`);
  process.exit(1);
}

// The TYPES section is ByVersion's sort.Interface methods, which the port doesn't have.
const doc = go("doc", "-all", "golang.org/x/mod/semver").split("\nTYPES\n")[0]!.trimEnd();
const out = `golang.org/x/mod/semver ${version}\n\n${doc}\n`;
fs.writeFileSync(path.join(DATA_DIR, "spec.txt"), out);
console.log(`wrote data/spec.txt (golang.org/x/mod ${version}, ${out.length} chars)`);
