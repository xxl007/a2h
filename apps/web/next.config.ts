import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Its presence turns on the Web component in infra/web.ts. No `output`:
// OpenNext (through SST) builds and packages the app.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The monorepo root, for file tracing of workspace packages. Explicit so
  // that a lockfile outside the repo is never taken for the workspace root.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default nextConfig;
