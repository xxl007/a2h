// The package version, reported as the MCP server's version. Read from
// package.json at runtime: src/ sits one level below the package root (tests,
// type stripping), dist/src/ two levels (the image; `pnpm deploy` ships
// package.json at the root).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readVersion(): string {
  for (const path of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(path) as { name?: string; version?: string };
      if (pkg.name === "@a2h/mcp" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // not at this level
    }
  }
  throw new Error("package.json of @a2h/mcp not found");
}

export const PACKAGE_VERSION: string = readVersion();
