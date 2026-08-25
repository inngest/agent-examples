// Deterministic statistics for aggregate-run. Everything here is pure so the
// aggregation step is trivially reproducible from the committed rows.

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Sample variance (n-1 denominator); null when variance is undefined.
export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1);
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// pass@k with exactly k samples per task = "at least one of the k samples
// passed all tests", computed per task and averaged over tasks. (With n == k
// the unbiased combinatorial estimator degenerates to this indicator, so the
// empirical form is the honest one to report.)
export type TaskSample = {
  compiled: boolean | null;
  testsPassed: number | null;
  testsTotal: number | null;
};

export function sampleFullyPasses(s: TaskSample): boolean | null {
  if (s.compiled === null || s.testsPassed === null || s.testsTotal === null) return null;
  return s.compiled && s.testsTotal > 0 && s.testsPassed === s.testsTotal;
}

export function samplePassRate(s: TaskSample): number | null {
  if (s.testsTotal === null || s.testsPassed === null || s.testsTotal === 0) return null;
  return s.testsPassed / s.testsTotal;
}
