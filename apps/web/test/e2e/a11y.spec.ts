// Accessibility checks on the built pages (design.md "Accessibility"): 44 px
// targets at 390 px and 1280 px, keyboard order on the sign-in form, one h1,
// no horizontal scroll at 320 px, reduced motion respected (no animation).
import { expect, test, type Page } from "@playwright/test";
import { EMAIL } from "./lib/env";
import { signIn } from "./lib/browser";

async function targets(page: Page): Promise<{ name: string; w: number; h: number }[]> {
  return page.$$eval("main button, main input:not([type=hidden]), main a[class*=Button], header button", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { name: (el.textContent || (el as HTMLInputElement).name || el.tagName).trim(), w: r.width, h: r.height };
    }),
  );
}

for (const width of [390, 1280]) {
  test(`targets are at least 44 px at ${width} px (sign-in, expired, signed-out, connected apps)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/sign-in", "/sign-in/expired", "/signed-out"]) {
      await page.goto(path);
      for (const t of await targets(page)) expect.soft(Math.min(t.w, t.h), `${path} ${t.name}`).toBeGreaterThanOrEqual(44);
      await expect(page.locator("h1")).toHaveCount(1);
    }
    await page.goto("/sign-in");
    await signIn(page, EMAIL);
    await expect(page).toHaveURL(/\/account\/clients/);
    for (const t of await targets(page)) expect.soft(Math.min(t.w, t.h), `/account/clients ${t.name}`).toBeGreaterThanOrEqual(44);
  });
}

test("keyboard: the sign-in form is reachable and submits with Enter; focus is visible", async ({ page }) => {
  await page.goto("/sign-in");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email address")).toBeFocused();
  const outline = await page.getByLabel("Email address").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeFocused();
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Email address").press("Enter");
  await expect(page).toHaveURL(/\/sign-in\/sent/);
});

test("no horizontal scroll at 320 px; reduced motion leaves nothing animated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/sign-in", "/sign-in/expired", "/signed-out"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
    const animated = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).animationName !== "none").length);
    expect(animated, path).toBe(0);
  }
});
