// Port of golang.org/x/mod/semver. Match the Go behavior exactly:
// invalid input returns "" (or false / the documented Go result), never throws.

export function IsValid(v: string): boolean {
  throw new Error("not implemented");
}

export function Canonical(v: string): string {
  throw new Error("not implemented");
}

export function Major(v: string): string {
  throw new Error("not implemented");
}

export function MajorMinor(v: string): string {
  throw new Error("not implemented");
}

export function Prerelease(v: string): string {
  throw new Error("not implemented");
}

export function Build(v: string): string {
  throw new Error("not implemented");
}

export function Compare(v: string, w: string): number {
  throw new Error("not implemented");
}

export function Max(v: string, w: string): string {
  throw new Error("not implemented");
}

// Returns a new array sorted ascending by semver precedence, as Go's Sort does
// (invalid versions sort before valid ones, ties broken by string order).
export function Sort(list: string[]): string[] {
  throw new Error("not implemented");
}
