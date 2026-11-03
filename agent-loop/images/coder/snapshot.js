#!/usr/bin/env node
// Prints every .ts file under the current directory as JSON, keyed by path:
// how an attempt hands its code back (src/agents/coder.ts).
const fs = require("node:fs");

const files = {};
for (const file of fs.readdirSync(".", { recursive: true })) {
  if (String(file).endsWith(".ts")) files[file] = fs.readFileSync(file, "utf8");
}
process.stdout.write(JSON.stringify(files));
