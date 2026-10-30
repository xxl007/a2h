import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const sources = [...files(src), ...files(join(root, ".storybook"))].filter((f) => /\.(css|tsx?)$/.test(f));
const tokensCss = readFileSync(join(src, "tokens", "tokens.css"), "utf8");
const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

describe("tokens (skill §2, ADR 0003 D2)", () => {
  it("no hex, rgb, hsl or oklch colour literal anywhere in packages/ui until the primitives tier exists", () => {
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/.test(text);
    });
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it("every var(--role) used by a component, screen or story is defined in tokens.css", () => {
    const used = new Set(sources.flatMap((file) => [...readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])));
    const undefinedRoles = [...used].filter((name) => !defined.has(name));
    expect(undefinedRoles).toEqual([]);
  });

  it("defines every semantic role the skill names", () => {
    const roles = ["--surface", "--surface-2", "--text", "--text-muted", "--border", "--border-strong", "--accent", "--on-accent", "--focus"];
    for (const status of ["success", "pending", "danger", "neutral"]) roles.push(`--${status}-bg`, `--${status}-border`, `--${status}-text`);
    expect(roles.filter((role) => !defined.has(role))).toEqual([]);
  });

  it("motion only under prefers-reduced-motion: no-preference", () => {
    for (const file of sources.filter((f) => f.endsWith(".css"))) {
      const text = readFileSync(file, "utf8");
      const outside = text.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/g, "");
      expect(/\b(transition|animation)\s*:/.test(outside), relative(root, file)).toBe(false);
    }
  });
});
