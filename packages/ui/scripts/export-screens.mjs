// Exports each approval-page state from the built Storybook to one self-contained HTML file
// (design.md "Screens" of m2-approval-page and m2-attachments: static HTML specs). Run after
// `pnpm build-storybook`:
//   node scripts/export-screens.mjs [approval|attachments] [outDir]
// Uses the Playwright of the tests package; nothing here ships in the app.
/* global process, URL, document, console -- a Node script whose page callbacks run in the browser */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const repo = resolve(here, "../..");
const set = process.argv[2] ?? "approval";
const sets = {
  approval: { change: "m2-approval-page", dir: "openspec/changes/archive/2026-11-07-m2-approval-page/screens" },
  attachments: { change: "m2-attachments", dir: "openspec/changes/archive/2026-11-11-m2-attachments/screens" },
};
if (!(set in sets)) throw new Error(`Unknown set ${set}; use ${Object.keys(sets).join(" or ")}`);
const out = resolve(process.argv[3] ?? join(repo, sets[set].dir));
const staticDir = join(here, "storybook-static");
const { chromium } = createRequire(join(repo, "tests/package.json"))("@playwright/test");

// Story id → file name, title shown in the index, in design.md order.
const approvalStates = [
  ["approval-awaiting", "a1-awaiting", "A1 Awaiting decision (paid, simulated participant)"],
  ["approval-link-ending", "a1d-link-ending", "A1 Awaiting decision (less than an hour of the link left)"],
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

const attachmentStates = [
  ["files-empty", "f1-empty", "F1 No files yet: the section, its limits, the upload control"],
  ["files-uploading", "f2-uploading", "F2 Uploading, with progress"],
  ["files-checking", "f3-checking", "F3 Checking"],
  ["files-ready", "f4-ready", "F4 Ready: Send available"],
  ["files-refused-type", "f5a-refused-type", "F5a Refused: type not allowed"],
  ["files-refused-size", "f5b-refused-size", "F5b Refused: over 25 MB"],
  ["files-refused-total", "f5c-refused-total", "F5c Refused: over 50 MB together"],
  ["files-refused-count", "f5d-refused-count", "F5d Refused: a sixth file"],
  ["files-refused-security-check", "f5e-refused-security", "F5e Refused by the security check"],
  ["files-refused-not-checked", "f5f-refused-not-checked", "F5f Refused: check did not finish"],
  ["files-refused-upload-failed", "f5g-refused-upload-failed", "F5g Refused: upload did not finish"],
  ["files-mixed", "f6-mixed", "F6 Several files mixed: Send unavailable while files upload"],
  ["files-refused-listed", "f7-refused-listed", "F7 A refused file listed: Send unavailable"],
  ["files-full", "f8-full", "F8 Five files: adding unavailable"],
  ["files-removing", "f9-removing", "F9 Removing a file"],
  ["files-sending", "f10-sending", "F10 Sending with files"],
  ["files-refused-rules", "f11-refused-rules", "F11 Send refused: outside the participant's rules, with files"],
  ["files-not-ready-at-send", "f11b-not-ready", "F11b Send refused: a file was not ready"],
  ["files-offline", "f12-offline", "F12 Offline with files"],
  ["files-sent", "f13-sent", "F13 Sent: files listed, open only"],
  ["files-not-sent", "f14-not-sent", "F14 Not sent: the files go"],
  ["files-phone-photo", "f15-phone-photo", "F15 Phone, 390 px: a photo chosen from the library"],
];
const states = set === "attachments" ? attachmentStates : approvalStates;

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
<title>${title} · A2H approval page spec (${sets[set].change})</title>
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
<p>Change <code>${sets[set].change}</code>, design.md section "Screens". Exported from the Storybook build of <code>packages/ui</code>; the stories are the interactive version. Light or dark follows your system setting.</p>
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
