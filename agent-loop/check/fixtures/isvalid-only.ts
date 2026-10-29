// Fixture: IsValid answers correctly, everything else throws.
import { IsValid as lookupIsValid } from "./lookup-impl.js";

export const IsValid = lookupIsValid;
const nope = (): never => {
  throw new Error("not implemented");
};
export const Canonical = nope;
export const Major = nope;
export const MajorMinor = nope;
export const Prerelease = nope;
export const Build = nope;
export const Compare = nope;
export const Max = nope;
export const Sort = nope;
