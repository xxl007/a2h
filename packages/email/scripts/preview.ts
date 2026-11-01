// Writes the magic-link email as it renders, for review in a browser:
//   pnpm --filter @a2h/email preview
// Output: packages/email/out/magic-link.{prod,preview}.{html,txt}
// (gitignored). The link is a placeholder; nothing is sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMagicLink, stageLabel } from "../src/index.ts";

const out = fileURLToPath(new URL("../out/", import.meta.url));
mkdirSync(out, { recursive: true });
const link = "https://a2h-protocol.org/api/auth/magic-link/verify?token=EXAMPLE";

for (const [name, stage] of [["prod", "prod"], ["preview", "pr-12"]] as const) {
  const m = await renderMagicLink({ link, expiresInMinutes: 15, productName: "A2H", stage: stageLabel(stage) });
  writeFileSync(`${out}magic-link.${name}.html`, m.html);
  writeFileSync(`${out}magic-link.${name}.txt`, `Subject: ${m.subject}\n\n${m.text}`);
  process.stdout.write(`${out}magic-link.${name}.html\n`);
}
