// Exports each approval-page state from the built Storybook to one self-contained HTML file
// (m2-approval-page design.md, Screens: static HTML specs). Run after `pnpm build-storybook`:
//   node scripts/export-screens.mjs [outDir]
// Uses the Playwright of the tests package; nothing here ships in the app.
/* global process, URL, document, console -- a Node script whose page callbacks run in the browser */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const repo = resolve(here, "../..");
const out = resolve(process.argv[2] ?? join(repo, "openspec/changes/m2-approval-page/screens"));
const staticDir = join(here, "storybook-static");
const { chromium } = createRequire(join(repo, "tests/package.json"))("@playwright/test");

// Story id → file name, title shown in the index, in design.md order.
const states = [
  ["approval-awaiting", "a1-awaiting", "A1 Awaiting decision (paid, simulated participant)"],
  ["approval-poll-free-deferred", "a1b-poll-free-deferred", "A1 Awaiting decision (poll with options and scale, free lane, deferred delivery)"],
  ["approval-real-participant", "a1c-real-participant", "A1 Awaiting decision (participant not simulated, production: no stage line)"],
  ["approval-edited", "a2-edited", "A2 Edited (Restore agent draft)"],
  ["approval-empty", "a2b-empty", "A2 Question emptied (Send unavailable)"],
  ["approval-over-limit", "a2c-over-limit", "A2 Over the limit (Send unavailable)"],
  ["approval-sending", "a3-sending", "A3 Sending"],
  ["approval-cancelling", "a3b-cancelling", "A3 Cancelling (Don't send pressed)"],
  ["approval-refused-content", "a4-refused-content", "A4 Validation failed after an edit (content rule)"],
  ["approval-refused-rules", "a4b-refused-rules", "A4 Validation failed (no longer fits their rules)"],
  ["approval-refused-budget", "a4c-refused-budget", "A4 Validation failed (over budget)"],
  ["approval-error", "a5-error", "A5 Error (choice not recorded)"],
  ["approval-offline", "a6-offline", "A6 Offline"],
  ["approval-sent", "a7-sent", "A7 Sent"],
  ["approval-already-sent", "a8-already-sent", "A8 Already decided: sent"],
  ["approval-already-not-sent", "a8b-already-not-sent", "A8 Already decided: not sent"],
  ["approval-not-sent", "a9-not-sent", "A9 Not sent"],
  ["approval-expired", "a10-expired", "A10 Link expired (also a forged link)"],
  ["approval-wrong-principal", "a11-wrong-principal", "A11 Wrong principal"],
  ["approval-sign-in", "a12-sign-in", "A12 Signed out: sign in, then back to the page"],
];

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const path = join(staticDir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
for (const [story, file, title] of states) {
  await page.goto(`${base}/iframe.html?id=screens--${story}&viewMode=story`);
  await page.waitForSelector("#storybook-root > *");
  const { css, body } = await page.evaluate(() => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) rules.push(rule.cssText);
      } catch {
        // A cross-origin sheet cannot be read; Storybook serves none of ours that way.
      }
    }
    // Storybook's own preview chrome is not part of the spec.
    const css = rules.filter((r) => !/sb-|#storybook-|@font-face/.test(r)).join("\n");
    return { css, body: document.querySelector("#storybook-root").innerHTML };
  });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · A2H approval page spec</title>
<!-- Static spec exported from Storybook story Screens/${story} by packages/ui/scripts/export-screens.mjs.
     Not interactive. Times are shown in Europe/Paris; the page shows the viewer's own zone. -->
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
  writeFileSync(join(out, `${file}.html`), html);
}
const list = states.map(([, file, title]) => `<li><a href="${file}.html">${title}</a></li>`).join("\n");
writeFileSync(
  join(out, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approval page, static specs · A2H</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 62ch; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Approval page: one static spec per state</h1>
<p>Change <code>m2-approval-page</code>, design.md section "Screens". Exported from the Storybook build of <code>packages/ui</code>; the stories are the interactive version. Light or dark follows your system setting.</p>
<ol>
${list}
</ol>
</body>
</html>
`,
);
await browser.close();
server.close();
console.log(`${states.length} states written to ${out}`);
