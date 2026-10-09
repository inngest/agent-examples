// Fixture: correct everywhere except it throws instead of returning "" for invalid input.
import * as L from "./lookup-impl.js";

function noEmpty<A extends unknown[], R>(name: string, f: (...a: A) => R) {
  return (...a: A): R => {
    const r = f(...a);
    if (r === "") throw new Error(`${name}: invalid version`);
    return r;
  };
}
export const IsValid = L.IsValid;
export const Canonical = noEmpty("Canonical", L.Canonical);
export const Major = noEmpty("Major", L.Major);
export const MajorMinor = noEmpty("MajorMinor", L.MajorMinor);
export const Prerelease = noEmpty("Prerelease", L.Prerelease);
export const Build = noEmpty("Build", L.Build);
export const Compare = L.Compare;
export const Max = noEmpty("Max", L.Max);
export const Sort = L.Sort;
