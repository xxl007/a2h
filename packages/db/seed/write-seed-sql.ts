// Writes seed/seed.sql from seed/simulated.ts: `pnpm --filter @a2h/db seed:sql`.
import { writeFileSync } from "node:fs";
import { SEED_SQL_PATH, seedSql } from "./sql.ts";

writeFileSync(SEED_SQL_PATH, seedSql());
console.log(`seed: wrote ${SEED_SQL_PATH}`);
