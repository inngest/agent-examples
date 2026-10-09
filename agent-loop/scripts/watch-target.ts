// Imported first by watch-goal.ts, before anything creates the Inngest client:
// --dev / --cloud override INNGEST_DEV from .env, so one checkout can watch
// (and start, and review) goals on either the dev server or Inngest Cloud.
const argv = process.argv.slice(2);
if (argv.includes("--dev") && argv.includes("--cloud")) {
  console.error("pass --dev or --cloud, not both");
  process.exit(2);
}
if (argv.includes("--dev")) process.env.INNGEST_DEV = process.env.INNGEST_DEV?.startsWith("http") ? process.env.INNGEST_DEV : "1";
if (argv.includes("--cloud")) process.env.INNGEST_DEV = "0";

// Same reading as the SDK: unset / 0 / false means Cloud; a URL is a dev server.
const dev = (process.env.INNGEST_DEV ?? "").trim();
export const isDevTarget = dev !== "" && dev !== "0" && dev.toLowerCase() !== "false";
export const targetLabel = isDevTarget ? `dev server ${dev.startsWith("http") ? dev : "localhost:8288"}` : "Inngest Cloud";
