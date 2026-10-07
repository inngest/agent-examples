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
};
