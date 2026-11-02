import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Its presence turns on the Web component in infra/web.ts. No `output`:
// OpenNext (through SST) builds and packages the app.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The monorepo root, for file tracing of workspace packages. Explicit so
  // that a lockfile outside the repo is never taken for the workspace root.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // @a2h/ui ships TypeScript and CSS modules as source (design.md, open
  // question 7).
  transpilePackages: ["@a2h/ui"],
  // @a2h/ui imports its TypeScript siblings with `.js` specifiers (NodeNext
  // style); webpack resolves them to the .ts/.tsx sources.
  webpack: (config: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
