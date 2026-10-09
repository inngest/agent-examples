// The one slice of Inngest's `step` that the helpers here need, so they can
// take either function's step (and a fake one in tests).
export type RunStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>;
};
