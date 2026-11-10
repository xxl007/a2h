// A walk over source files for tests that scan the repository (review B2).
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs)$/;

/**
 * Every source file under `dir`, skipping the directories named in `skip` and
 * every dot-directory without entering them, so nothing another process
 * creates or deletes there (node_modules, .turbo, build output) can fail it.
 */
export function sourceFiles(dir: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, d.name);
    if (d.isDirectory()) {
      if (skip.has(d.name) || d.name.startsWith(".")) continue;
      out.push(...sourceFiles(path, skip));
    } else if (d.isFile() && SOURCE.test(d.name)) {
      out.push(path);
    }
  }
  return out;
}
