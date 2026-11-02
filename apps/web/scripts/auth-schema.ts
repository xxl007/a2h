// Regenerates packages/db/src/auth-schema.ts from the Better Auth CLI
// (`pnpm --filter @a2h/web auth:schema`): the CLI output for
// scripts/auth-cli.config.ts, with the header in scripts/auth-schema.header.txt
// and the `authSchema` map the Drizzle adapter takes. Then run
// `pnpm --filter @a2h/db generate` for the migration.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const out = new URL("../../../packages/db/src/auth-schema.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "a2h-auth-schema-"));
try {
  const file = join(dir, "auth-schema.ts");
  execFileSync("pnpm", ["dlx", "auth@1.7.14", "generate", "--config", "scripts/auth-cli.config.ts", "--output", file, "-y"], {
    cwd: join(here, ".."),
    stdio: "inherit",
  });
  const generated = readFileSync(file, "utf8");
  const tables = [...generated.matchAll(/^export const (\w+) = pgTable\(/gm)].map((m) => m[1] ?? "");
  const header = readFileSync(join(here, "auth-schema.header.txt"), "utf8");
  const footer = `\n/** The tables by Better Auth model name, for its Drizzle adapter (\`drizzleAdapter(db, { schema: authSchema })\`). */\nexport const authSchema = {\n${tables.map((t) => `  ${t},`).join("\n")}\n};\n`;
  writeFileSync(out, header + generated + footer);
  console.log(`auth-schema: ${tables.length} tables -> packages/db/src/auth-schema.ts`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
