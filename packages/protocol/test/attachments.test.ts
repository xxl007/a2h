// m2-attachments task 2.1: the attachment constants, the participant's
// attachment setting (spec protocol/schemas "Rules of engagement state the
// participant's attachment setting") and the file summary of check_requests
// ("Requests report their files without content").
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENTS_MAX,
  ATTACHMENTS_MAX_TOTAL_BYTES,
  AttachmentSettingSchema,
  CheckedRequestSchema,
  DEFAULT_ATTACHMENT_SETTING,
  FILE_REFUSED_REASONS,
  FILE_STATES,
  FileIdSchema,
  fileSummaryOf,
  formatFileId,
  ManifestSchema,
  ProfileSchema,
  RulesOfEngagementSchema,
  toJsonSchema,
} from "../src/index.ts";
import { referenceChecked, referenceManifest, referenceProfile, referenceRules } from "./fixtures.ts";

const MB = 1024 * 1024;

describe("attachment constants (proposal decisions 1 and 3)", () => {
  test("5 files, 25 MB each, 50 MB per request", () => {
    assert.equal(ATTACHMENTS_MAX, 5);
    assert.equal(ATTACHMENT_MAX_BYTES, 25 * MB);
    assert.equal(ATTACHMENTS_MAX_TOTAL_BYTES, 50 * MB);
  });
  test("allowed types: PDF, PNG, JPEG, WebP, plain text, CSV, Markdown; nothing else", () => {
    assert.deepEqual([...ATTACHMENT_MEDIA_TYPES], ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "text/markdown"]);
  });
  test("file states and refusal reasons (design D1)", () => {
    assert.deepEqual([...FILE_STATES], ["uploading", "checking", "ready", "refused"]);
    assert.deepEqual([...FILE_REFUSED_REASONS], ["type", "size", "count", "malware", "not_checked", "upload_failed"]);
  });
});

describe("file ids (design D1: 16 random bytes, base64url, the protocol ref)", () => {
  test("formatFileId: 'f' + 22 base64url characters, an opaque id; the caller draws the bytes", () => {
    const id = formatFileId(Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 251) & 255));
    assert.match(id, /^f[A-Za-z0-9_-]{22}$/);
    assert.ok(FileIdSchema.safeParse(id).success);
    assert.equal(formatFileId(new Uint8Array(16)), "fAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(formatFileId(new Uint8Array(16).fill(255)), "f_____________________w");
    assert.throws(() => formatFileId(new Uint8Array(15)), RangeError);
  });
  test("a manifest attachment's ref may be a file id", () => {
    const ref = formatFileId(new Uint8Array(16).fill(7));
    assert.ok(ManifestSchema.safeParse({ ...referenceManifest, attachments: [{ ref, media_type: "application/pdf", size_bytes: 2 * MB }] }).success);
  });
});

describe("Requirement: Rules of engagement state the participant's attachment setting", () => {
  test("Scenario: Setting present: rules accepting files up to 10 MB parse with attachments { accepted: true, max_total_bytes: 10485760 }", () => {
    const parsed = RulesOfEngagementSchema.parse({ ...referenceRules, attachments: { accepted: true, max_total_bytes: 10 * MB } });
    assert.deepEqual(parsed.attachments, { accepted: true, max_total_bytes: 10485760 });
  });

  test("Scenario: Rules without the setting: rules recorded before this change parse with files accepted up to 50 MB", () => {
    const before = { ...referenceRules } as Record<string, unknown>;
    delete before["attachments"];
    const parsed = RulesOfEngagementSchema.parse(before);
    assert.deepEqual(parsed.attachments, { accepted: true, max_total_bytes: 52428800 });
    assert.deepEqual(DEFAULT_ATTACHMENT_SETTING, { accepted: true, max_total_bytes: ATTACHMENTS_MAX_TOTAL_BYTES });
  });

  test("the total is a whole number of bytes, at most 50 MB, not negative; the shape is closed", () => {
    for (const bad of [{ accepted: true, max_total_bytes: 50 * MB + 1 }, { accepted: true, max_total_bytes: -1 }, { accepted: true, max_total_bytes: 1.5 }, { accepted: true }, { accepted: true, max_total_bytes: 1, name: "x" }]) {
      assert.equal(AttachmentSettingSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.ok(AttachmentSettingSchema.safeParse({ accepted: false, max_total_bytes: 0 }).success);
  });

  test("discovery does not publish the setting: the profile shape has no attachments field and refuses one", () => {
    assert.ok(!("attachments" in ProfileSchema.shape));
    assert.equal(ProfileSchema.safeParse({ ...referenceProfile, attachments: { accepted: true, max_total_bytes: MB } }).success, false);
  });
});

describe("Requirement: Requests report their files without content", () => {
  const sent = { ...referenceChecked };

  test("Scenario: Request with files: a PDF of 2 MB and a PNG of 300 KB → two files with those types and sizes, no name or link", () => {
    const attachments = [
      { ref: "fAAAAAAAAAAAAAAAAAAAAAA", media_type: "application/pdf", size_bytes: 2 * MB },
      { ref: "fAQEBAQEBAQEBAQEBAQEBAQ", media_type: "image/png", size_bytes: 300 * 1024 },
    ] as const;
    const files = fileSummaryOf(attachments);
    assert.deepEqual(files, [
      { media_type: "application/pdf", size_bytes: 2097152 },
      { media_type: "image/png", size_bytes: 307200 },
    ]);
    const r = CheckedRequestSchema.safeParse({ ...sent, files });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.equal(r.data?.files.length, 2);
    // Nothing else about a file: a name, a link or a ref is refused.
    for (const extra of [{ name: "leaflet.pdf" }, { url: "https://example.com/f" }, { ref: "fAAAAAAAAAAAAAAAAAAAAAA" }]) {
      assert.equal(CheckedRequestSchema.safeParse({ ...sent, files: [{ ...files[0], ...extra }] }).success, false, JSON.stringify(extra));
    }
  });

  test("Scenario: Request without files: the summary carries zero files", () => {
    assert.deepEqual(fileSummaryOf(undefined), []);
    assert.deepEqual(fileSummaryOf(null), []);
    const r = CheckedRequestSchema.safeParse({ ...sent, files: [] });
    assert.ok(r.success);
    assert.deepEqual(r.data?.files, []);
    // The field is required: a summary without it is malformed.
    const without = { ...sent } as Record<string, unknown>;
    delete without["files"];
    assert.equal(CheckedRequestSchema.safeParse(without).success, false);
  });

  test("at most 5 files, of allowed types, each within 25 MB", () => {
    const one = { media_type: "application/pdf", size_bytes: MB };
    assert.equal(CheckedRequestSchema.safeParse({ ...sent, files: Array(6).fill(one) }).success, false);
    assert.equal(CheckedRequestSchema.safeParse({ ...sent, files: [{ media_type: "application/zip", size_bytes: MB }] }).success, false);
    assert.equal(CheckedRequestSchema.safeParse({ ...sent, files: [{ media_type: "image/png", size_bytes: 25 * MB + 1 }] }).success, false);
  });

  test("the JSON Schema of a checked request names files as required, items closed to media_type and size_bytes", () => {
    const js = toJsonSchema(CheckedRequestSchema) as { required: string[]; properties: Record<string, { items: { properties: Record<string, unknown>; additionalProperties: boolean } }> };
    assert.ok(js.required.includes("files"));
    assert.deepEqual(Object.keys(js.properties["files"]!.items.properties).sort(), ["media_type", "size_bytes"]);
    assert.equal(js.properties["files"]!.items.additionalProperties, false);
  });
});

describe("the manifest's attachments (design D4)", () => {
  test("allowed types only, at most 5, each within 25 MB, 50 MB in all", () => {
    const att = (media_type: string, size_bytes: number, i = 0) => ({ ref: `f${String(i).padStart(22, "A")}`, media_type, size_bytes });
    const ok = (a: unknown[]) => ManifestSchema.safeParse({ ...referenceManifest, attachments: a }).success;
    assert.ok(ok([att("application/pdf", 25 * MB), att("image/webp", 25 * MB, 1)]));
    assert.equal(ok([att("application/pdf", 25 * MB), att("image/webp", 25 * MB, 1), att("text/plain", 1, 2)]), false, "over 50 MB in all");
    assert.equal(ok([att("text/html", 10)]), false, "type not allowed");
    assert.equal(ok(Array.from({ length: 6 }, (_, i) => att("text/csv", 10, i))), false, "six files");
  });
});
