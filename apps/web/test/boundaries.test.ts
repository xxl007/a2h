// CLAUDE.md "Keep business logic provider-neutral": in apps/web only
// apps/web/infra imports an AWS SDK (design D2, task 5.1). app/ and src/ reach
// AWS through the adapters in infra/ (composition root src/server/runtime.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const AWS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:@aws-sdk\/[^"']*|aws-sdk|@smithy\/[^"']*)["']/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe("AWS SDK imports", () => {
  test("app/ and src/ import no AWS SDK", () => {
    const offenders = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "src"))].filter((f) => AWS_IMPORT.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the pattern catches an import (guard against a broken pattern)", () => {
    expect(AWS_IMPORT.test(`import { S3Client } from "@aws-sdk/client-s3";`)).toBe(true);
    expect(AWS_IMPORT.test(`const x = await import("@aws-sdk/client-ssm")`)).toBe(true);
    expect(AWS_IMPORT.test(`import { ensurePrincipal } from "@a2h/db";`)).toBe(false);
  });

  test("infra/ is where the Data API, SSM and S3 clients live", () => {
    const infra = sources(join(ROOT, "infra")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(infra).toMatch(/@aws-sdk\/client-rds-data/);
  });
});
