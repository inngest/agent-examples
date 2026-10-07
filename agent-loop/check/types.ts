export type CaseSet = "train" | "holdout";

export type CheckResult = {
  commit: string; // workspace sha that was scored
  checkVersion: string; // hash of check/ source + case file contents
  set: CaseSet;
  total: number;
  failed: number;
  score: number; // failed / total, lower is better
  pass: boolean; // failed === 0
  report: string; // what the agent reads next attempt (train only; "" for holdout)
  // Train only, for the loop's attempt-to-attempt context:
  byFn?: Record<string, { total: number; failed: number }>; // per-function failures
  failBits?: string; // base64 bitset over the train cases in file order, set = failing
  examples?: string[]; // failing-case lines (report format), round-robin across the worst functions
  regressions?: { count: number; examples: string[] }; // vs `against`: cases that passed there and fail here
};
