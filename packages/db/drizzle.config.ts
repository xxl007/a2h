// drizzle-kit configuration: `pnpm --filter @a2h/db generate` writes the SQL
// migrations into migrations/ from src/schema.ts and src/auth-schema.ts. No credentials: generation
// needs no database. Migrations are applied by .github/scripts/db-migrate.sh
// (design D2), never by drizzle-kit against a deployed stage.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/auth-schema.ts"],
  out: process.env["DRIZZLE_OUT"] ?? "./migrations",
});
