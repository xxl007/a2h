// Task 6.1: the magic-link template renders the link and the 15-minute,
// single-use validity in both bodies; the email carries nothing else
// (spec principal-identity "Sign-in by magic link to an allow-listed address").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMagicLink } from "../src/index.ts";

const link = "https://dev.a2h-protocol.org/api/auth/magic-link/verify?token=abc123XYZ&callbackURL=%2Fconsent";
const snapshot = fileURLToPath(new URL("./__snapshots__/magic-link.prod.txt", import.meta.url));

test("link and expiry appear in the HTML and the text", async () => {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H" });
  for (const body of [m.html, m.text]) {
    assert.ok(body.includes("15 minutes"), "expiry stated");
    assert.ok(body.includes("only once"), "single use stated");
    assert.ok(body.toLowerCase().includes("ignore this email"), "ignore if not requested");
  }
  // The HTML escapes & in attributes and text; the href decodes to the link.
  assert.ok(m.html.includes(`href="${link.replaceAll("&", "&amp;")}"`), "link is the button href");
  assert.ok(m.text.includes(link), "raw link in the text body");
  assert.equal(m.subject, "Your A2H sign-in link");
});

test("the text version matches the snapshot", async () => {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H" });
  if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(snapshot, m.text);
  assert.equal(m.text, readFileSync(snapshot, "utf8"));
});

test("a non-production stage is labelled in the subject and both bodies", async () => {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H", stage: "preview pr-12" });
  assert.equal(m.subject, "[preview pr-12] Your A2H sign-in link");
  assert.ok(m.html.includes("preview pr-12"));
  assert.ok(m.text.includes("preview pr-12"));
});

test("production carries no stage label", async () => {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H" });
  for (const word of ["preview", "development", "sink"]) {
    assert.ok(!m.html.toLowerCase().includes(word), `no "${word}" in html`);
    assert.ok(!m.text.toLowerCase().includes(word), `no "${word}" in text`);
  }
});

test("the email carries no data but the link and the expiry", async () => {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H" });
  const urls = [...m.text.matchAll(/https?:\/\/\S+/g)].map((x) => x[0]);
  assert.deepEqual([...new Set(urls)], [link]);
  assert.ok(!m.html.includes("<img"), "no images (image-less rendering, no tracking pixel)");
});

test("expiry is a positive whole number of minutes, at most 15", async () => {
  await assert.rejects(renderMagicLink({ link, expiresInMinutes: 16, productName: "A2H" }), RangeError);
  await assert.rejects(renderMagicLink({ link, expiresInMinutes: 0, productName: "A2H" }), RangeError);
  await assert.rejects(renderMagicLink({ link, expiresInMinutes: 2.5, productName: "A2H" }), RangeError);
  const five = await renderMagicLink({ link, expiresInMinutes: 5, productName: "A2H" });
  assert.ok(five.text.includes("5 minutes"));
});

test("only https links are accepted", async () => {
  await assert.rejects(renderMagicLink({ link: "javascript:alert(1)", expiresInMinutes: 15, productName: "A2H" }), TypeError);
  await assert.rejects(renderMagicLink({ link: "http://example.com/x", expiresInMinutes: 15, productName: "A2H" }), TypeError);
});

test("no colour value in the HTML until packages/ui tokens exist (ADR 0003)", async () => {
  for (const stage of [undefined, "preview pr-12"]) {
    const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H", stage });
    assert.doesNotMatch(m.html, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsla?\(/i);
    assert.doesNotMatch(m.html, /(^|[;"\s])(background-)?colou?r\s*:/i);
  }
});
