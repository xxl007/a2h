// m2-attachments task 3.2, design D3: the type of a file is read from its
// first bytes, never from its name or the browser's claim. Spec
// platform/attachments "Allowed file", "Type not allowed", "Name and content
// disagree". Pure: no storage, no database.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ATTACHMENT_MEDIA_TYPES, type AttachmentMediaType } from "@a2h/protocol";
import { SNIFF_BYTES, sniffFile } from "../src/files/sniff.ts";

const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "utf8")] : p)));

const SAMPLES: Record<AttachmentMediaType, Uint8Array> = {
  "application/pdf": bytes("%PDF-1.7\n%", [0xe2, 0xe3, 0xcf, 0xd3], "\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
  "image/png": bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  "image/jpeg": bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  "image/webp": bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ", [0x18, 0, 0, 0, 0x30, 0x01, 0, 0x9d, 0x01, 0x2a]),
  "text/plain": bytes("Bonjour, voici les notes de la réunion.\r\nDeuxième ligne\tavec tabulation.\n"),
  "text/csv": bytes("﻿name,score\nalice,3\n\"b, quoted\",4\n"),
  "text/markdown": bytes("# Leaflet\n\n- point one\n- point two — with a dash\n\n<details>inline html later in the file is text</details>\n"),
};

describe("file-check content sniffing (D3)", () => {
  test("SNIFF_BYTES is the first 8 KB", () => {
    assert.equal(SNIFF_BYTES, 8192);
  });

  for (const type of ATTACHMENT_MEDIA_TYPES) {
    test(`Allowed file: ${type} whose bytes are ${type} is accepted as ${type}`, () => {
      assert.deepEqual(sniffFile(SAMPLES[type], type), { ok: true, media_type: type });
    });
  }

  test("Scenario: Name and content disagree: a file declared as a PDF that contains an HTML document is refused", () => {
    const html = bytes("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>");
    assert.deepEqual(sniffFile(html, "application/pdf"), { ok: false });
  });

  test("an HTML or SVG document declared as text is refused (browsers would sniff it as markup)", () => {
    for (const doc of ["<!DOCTYPE html><p>x", "  \n<html><body>x", "<script>alert(1)</script>", "<svg xmlns='http://www.w3.org/2000/svg'/>", "<?xml version='1.0'?><svg/>", "﻿<HTML>", "<!-- c --><p>"]) {
      for (const type of ["text/plain", "text/csv", "text/markdown"] as const) {
        assert.deepEqual(sniffFile(bytes(doc), type), { ok: false }, `${JSON.stringify(doc)} as ${type}`);
      }
    }
  });

  test("Scenario: Type not allowed: a ZIP archive or an executable is refused, whatever it is declared as", () => {
    const zip = bytes("PK", [3, 4, 20, 0, 0, 0, 8, 0], "notes.txt");
    const exe = bytes("MZ", [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);
    const elf = bytes([0x7f], "ELF", [2, 1, 1, 0]);
    for (const content of [zip, exe, elf]) {
      for (const type of ATTACHMENT_MEDIA_TYPES) assert.deepEqual(sniffFile(content, type), { ok: false }, type);
    }
  });

  test("bytes of one allowed type declared as another are refused (no silent relabelling)", () => {
    for (const actual of ATTACHMENT_MEDIA_TYPES) {
      for (const declared of ATTACHMENT_MEDIA_TYPES) {
        const textual = (t: string) => t.startsWith("text/");
        if (actual === declared || (textual(actual) && textual(declared))) continue;
        assert.deepEqual(sniffFile(SAMPLES[actual], declared), { ok: false }, `${actual} declared ${declared}`);
      }
    }
  });

  test("text must be UTF-8 without NUL or control bytes", () => {
    assert.deepEqual(sniffFile(bytes("a,b\n", [0], "c\n"), "text/csv"), { ok: false }, "NUL");
    assert.deepEqual(sniffFile(bytes("caf", [0xe9], "\n"), "text/plain"), { ok: false }, "Latin-1, not UTF-8");
    assert.deepEqual(sniffFile(bytes("bell", [0x07]), "text/plain"), { ok: false }, "control byte");
  });

  test("a multibyte character cut by the 8 KB boundary does not refuse valid UTF-8", () => {
    const text = "é".repeat(SNIFF_BYTES); // 2 bytes each
    const head = new Uint8Array(Buffer.from(text, "utf8").subarray(0, SNIFF_BYTES - 1)); // ends mid-character
    assert.deepEqual(sniffFile(head, "text/plain", { truncated: true }), { ok: true, media_type: "text/plain" });
    assert.deepEqual(sniffFile(head, "text/plain", { truncated: false }), { ok: false }, "a whole file must decode completely");
  });

  test("an empty file or an unknown declared type is refused", () => {
    assert.deepEqual(sniffFile(new Uint8Array(0), "text/plain"), { ok: false });
    assert.deepEqual(sniffFile(SAMPLES["application/pdf"], "application/zip"), { ok: false });
  });
});
