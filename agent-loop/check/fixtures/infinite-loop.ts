// Fixture: every function spins forever.
const spin = (): never => {
  while (true) {}
};
export const IsValid = spin;
export const Canonical = spin;
export const Major = spin;
export const MajorMinor = spin;
export const Prerelease = spin;
export const Build = spin;
export const Compare = spin;
export const Max = spin;
export const Sort = spin;
