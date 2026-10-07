// The package.json / tsconfig.json every workspace carries. Shared by
// scripts/reset-workspace.ts (local git workspace) and the in-memory
// typecheck (sandbox backend) so both typecheck under identical settings.
export const WORKSPACE_PACKAGE_JSON =
  JSON.stringify({ name: "semver-port", version: "0.0.0", private: true, type: "module" }, null, 2) + "\n";

export const WORKSPACE_TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        // The sandbox grader runs semver.ts under node's native type stripping,
        // which rejects enums, namespaces and parameter properties. Make the
        // agent's typecheck reject them too, so it hears about it before the check.
        erasableSyntaxOnly: true,
        // Type stripping also doesn't rewrite import specifiers, so a relative
        // import must name the .ts file ("./parse.ts", not "./parse.js").
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n";
