// Configuration the Better Auth CLI loads to generate the Drizzle schema of
// its tables (`pnpm --filter @a2h/web auth:schema`, written to
// packages/db/src/auth-schema.ts). Same plugins as the deployed server
// (src/auth/auth.ts); the database is never connected.
import type { PrincipalsDb } from "@a2h/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth } from "../src/auth/auth";
import { createLogger } from "../src/log";

export const auth = createAuth({
  db: drizzle.mock() as unknown as PrincipalsDb,
  config: {
    baseURL: "http://localhost:3000",
    issuer: "http://localhost:3000/api/auth",
    mcpUrl: "http://localhost:3001/mcp",
    secret: "generate-only-secret-not-used-anywhere-0123456789",
  },
  sendMagicLink: () => Promise.resolve(),
  isAllowed: () => Promise.resolve(false),
  logger: createLogger({ write: () => undefined }),
});
