import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";

/** The port's source files, keyed by path relative to src/. */
export type Files = Record<string, string>;

/** The stub files a goal starts from. */
export const templateFiles = (): Files => ({
  "semver.ts": fs.readFileSync(path.join(REPO_ROOT, "workspace-template", "src", "semver.ts"), "utf8"),
});
