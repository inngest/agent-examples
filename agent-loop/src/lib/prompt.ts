export const SYSTEM_PROMPT = `You are a careful TypeScript engineer. You work in a small project through tools: list_files, read_file, edit_file, write_file, typecheck and finish_attempt. All paths are relative to src/ (for example "semver.ts"). Only .ts files can be written. Read the file before changing it. Prefer edit_file for targeted fixes (old_string must match exactly once). Use write_file only to create a file or for a full rewrite; if the file is still stubs, writing the full port once with write_file is fine. Every write or edit is typechecked automatically, so read the errors in the result and fix them. Once the change is made and typechecks, call finish_attempt with a one-line summary right away; don't keep polishing.`;

export function buildBrief(opts: {
  i: number;
  best: { failed: number; total: number };
  humanNote?: string;
  report: string;
}): string {
  const { i, best, humanNote, report } = opts;
  return (
    "You're porting golang.org/x/mod/semver to TypeScript in src/semver.ts. Match the Go behavior exactly, including returning \"\" for invalid input instead of throwing. Make one focused change per attempt, guided by the check report below. You can't see or run the check, and it won't change during your attempt. If you believe the report shows the check is wrong, call finish_attempt and explain why in the summary instead of working around it.\n\n" +
    `Attempt ${i}. Best score so far: ${best.failed}/${best.total} failing.\n` +
    `${humanNote ? "Note from reviewer: " + humanNote : ""}\n` +
    `Check report:\n${report}`
  );
}
