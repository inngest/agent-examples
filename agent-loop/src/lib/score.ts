// All scoring goes through here so SDK API changes touch one place.
// Uses step.score(memoizationId, { name, value }) from scoreMiddleware()
// (inngest/experimental): a durable score write attached to the current run.
type ScoreStep = {
  score: (id: string, opts: { name: string; value: number | boolean }) => Promise<void>;
};

export async function recordScore(
  step: ScoreStep,
  id: string,
  name: string,
  value: number | boolean,
): Promise<void> {
  await step.score(id, { name, value });
}
