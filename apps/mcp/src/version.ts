// The package version, reported as the MCP server's version. Read from
// package.json at runtime (src/ in tests, dist/ in the image: both sit one
// level below the package root, and `pnpm deploy` ships package.json).
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const PACKAGE_VERSION: string = pkg.version;
