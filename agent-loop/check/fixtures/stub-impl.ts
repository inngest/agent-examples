// Fixture: every function throws. Must score 1.
const nope = (): never => {
  throw new Error("not implemented");
};
export const IsValid = nope;
export const Canonical = nope;
export const Major = nope;
export const MajorMinor = nope;
export const Prerelease = nope;
export const Build = nope;
export const Compare = nope;
export const Max = nope;
export const Sort = nope;
