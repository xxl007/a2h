// drizzle-kit writes foreign keys as REFERENCES "public"."<table>" even for
// tables declared without a schema. A2H applies one migration set to `public`
// (dev, prod) and to `pr_<n>` (previews) through the search_path (design D2),
// so the pin is removed after every `drizzle-kit generate` (`pnpm generate`).
// Only that exact form is rewritten; test/schema.test.ts fails if any
// "public". remains in a migration file.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? new URL("../migrations/", import.meta.url).pathname;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
  const path = join(dir, file);
  const before = readFileSync(path, "utf8");
  const after = before.replaceAll('REFERENCES "public".', "REFERENCES ");
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`unpin-schema: ${file}`);
  }
}
