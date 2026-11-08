import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  approvalRequest,
  chartPng,
  fileRules,
  leafletPdf,
  notesMd,
  photoUploading,
  principalEmail,
  readingsCsv,
  refusedFiles,
  storyNow,
  storyTimeZone,
} from "../src/fixtures.js";
import {
  acceptAttribute,
  ApprovalScreen,
  copy,
  fileAnnouncements,
  filesGate,
  fileTypeLabel,
  formatFileSize,
  type ApprovalFile,
  type ApprovalFileRefusal,
  type ApprovalState,
} from "../src/index.js";

// m2-attachments design.md, Screens F0–F12; spec deltas platform/approval-page and platform/attachments.

const text = (html: string) =>
  html
    .replace(/<\/?time\b[^>]*>/g, "")
    // Every other element is its own line or chunk on screen, spans included (name, then type and size).
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const base = { email: principalEmail, timeZone: storyTimeZone, now: storyNow, request: approvalRequest, fileRules };
const render = (files: ApprovalFile[], state: ApprovalState = "awaiting", extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<ApprovalScreen {...base} state={state} files={files} {...extra} />);
const buttonTags = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
const sendTag = (html: string) => /<button[^>]*value="send"[^>]*>/.exec(html)?.[0] ?? "";
const describedBy = (tag: string) => (/aria-describedby="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ").filter(Boolean);
const byId = (html: string, id: string) => {
  const m = new RegExp(`<([a-z]+)[^>]*id="${id.replace(/[:]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return text(m?.[2] ?? "").trim();
};
const f = copy.approval.files;

describe("formatFileSize (sizes as the limits state them: 25 MB = 25 × 1024 × 1024 bytes)", () => {
  it("bytes, kilobytes, megabytes", () => {
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(68)).toBe("68 bytes");
    expect(formatFileSize(418 * 1024)).toBe("418 KB");
    expect(formatFileSize(1023 * 1024 + 900)).toBe("1 MB");
    expect(formatFileSize(Math.round(2.4 * 1024 * 1024))).toBe("2.4 MB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatFileSize(Math.round(31.5 * 1024 * 1024))).toBe("31.5 MB");
  });
});

describe("fileTypeLabel and acceptAttribute", () => {
  it("names the allowed types in words, and anything else as another type", () => {
    expect(fileRules.accept.map(fileTypeLabel)).toEqual(["PDF", "PNG image", "JPEG image", "WebP image", "Text", "CSV", "Markdown"]);
    expect(fileTypeLabel("application/zip")).toBe("Other type");
    expect(fileTypeLabel("")).toBe("Other type");
  });
  it("accept lists the media types and the extensions browsers need for text, CSV and Markdown", () => {
    const accept = acceptAttribute(fileRules.accept);
    for (const t of [...fileRules.accept, ".txt", ".csv", ".md", ".pdf", ".jpg", ".jpeg", ".png", ".webp"]) expect(accept).toContain(t);
    expect(accept).not.toMatch(/image\/\*|heic/);
  });
});

describe("filesGate (spec 'Send waits for checking', 'Refused file blocks Send until removed')", () => {
  it("no files, or every file ready: Send is available", () => {
    expect(filesGate([])).toEqual({ canSend: true, reason: null, refused: 0 });
    expect(filesGate([leafletPdf, chartPng])).toEqual({ canSend: true, reason: null, refused: 0 });
  });
  it("uploading, then checking, block Send", () => {
    expect(filesGate([leafletPdf, photoUploading, readingsCsv])).toMatchObject({ canSend: false, reason: "uploading" });
    expect(filesGate([leafletPdf, readingsCsv])).toMatchObject({ canSend: false, reason: "checking" });
  });
  it("a listed refused file blocks Send, and says how many to remove, before anything else", () => {
    expect(filesGate([readingsCsv, refusedFiles.type, refusedFiles.malware])).toEqual({ canSend: false, reason: "refused", refused: 2 });
  });
});

describe("fileAnnouncements (spec 'each state change is announced')", () => {
  it("first render announces nothing", () => {
    expect(fileAnnouncements(undefined, [leafletPdf])).toEqual([]);
  });
  it("a new file, each state change, a removal, and Send becoming available", () => {
    const uploading = { ...leafletPdf, state: "uploading" as const, progress: 0.1 };
    expect(fileAnnouncements([], [uploading])).toEqual(["Uploading when_to_call_v3.pdf."]);
    expect(fileAnnouncements([uploading], [{ ...uploading, progress: 0.6 }])).toEqual([]);
    const checking = { ...leafletPdf, state: "checking" as const };
    expect(fileAnnouncements([uploading], [checking])).toEqual(["when_to_call_v3.pdf uploaded. Checking it."]);
    expect(fileAnnouncements([checking], [leafletPdf])).toEqual(["when_to_call_v3.pdf is ready.", "Every file is ready. Send is available."]);
    expect(fileAnnouncements([checking, readingsCsv], [leafletPdf, readingsCsv])).toEqual(["when_to_call_v3.pdf is ready."]);
    const malware = { ...refusedFiles.malware, state: "checking" as const };
    delete (malware as Partial<ApprovalFile>).refusal;
    expect(fileAnnouncements([malware], [refusedFiles.malware], fileRules)).toEqual([
      `notes.txt refused. ${f.refusal.malware}`,
    ]);
    expect(fileAnnouncements([leafletPdf, chartPng], [chartPng])).toEqual(["when_to_call_v3.pdf removed."]);
    expect(fileAnnouncements([refusedFiles.type, chartPng], [chartPng])).toEqual(["leaflet-source.zip removed.", "Every file is ready. Send is available."]);
  });
  it("a file refused before it was stored (size, count) is announced with its reason", () => {
    expect(fileAnnouncements([], [refusedFiles.size], fileRules)).toEqual(["clinic-walkthrough-scan.pdf refused. This file is over 25 MB, the most for one file."]);
  });
});

describe("approval page with files: the list (spec 'The principal can attach files before Send')", () => {
  const files = [leafletPdf, chartPng, readingsCsv, photoUploading];
  const html = render(files);
  const t = text(html);

  it("the section sits between the question and the request details, under its heading, with the limits", () => {
    const q = t.indexOf(copy.approval.questionLabel);
    const h = t.indexOf("Files they will consult");
    const d = t.indexOf("Request details");
    expect(q).toBeGreaterThanOrEqual(0);
    expect(h).toBeGreaterThan(q);
    expect(d).toBeGreaterThan(h);
    expect(t).toContain("Optional. Up to 5 files, 25 MB each and 50 MB in all: PDF, PNG, JPEG, WebP, plain text, CSV or Markdown.");
    expect(html).toMatch(/<ul[^>]*aria-labelledby="[^"]+"/);
  });

  it("each file shows its name, type, size and state, in words", () => {
    expect(t).toContain("when_to_call_v3.pdf PDF · 2.4 MB Ready");
    expect(t).toContain("glucose-thresholds-chart.png PNG image · 418 KB Ready");
    expect(t).toContain("readings_week_42.csv CSV · 36 KB Checking");
    expect(t).toContain("IMG_2041.jpg JPEG image · 3.1 MB Uploading 42%");
  });

  it("uploading shows a progress bar named after the file", () => {
    expect(html).toMatch(/<progress[^>]*aria-label="Uploading IMG_2041.jpg"[^>]*max="100"[^>]*value="42"|<progress[^>]*value="42"[^>]*max="100"[^>]*aria-label="Uploading IMG_2041.jpg"/);
  });

  it("Open only on ready files; Remove on every file, each named after its file", () => {
    const labels = buttonTags(html)
      .map((b) => /aria-label="([^"]*)"/.exec(b)?.[1])
      .filter((l) => l !== undefined && /^(Open|Remove) /.test(l));
    expect(labels).toEqual([
      "Open when_to_call_v3.pdf",
      "Remove when_to_call_v3.pdf",
      "Open glucose-thresholds-chart.png",
      "Remove glucose-thresholds-chart.png",
      "Remove readings_week_42.csv",
      "Remove IMG_2041.jpg",
    ]);
    for (const b of buttonTags(html).filter((b) => /aria-label="(Open|Remove) /.test(b))) expect(b).toContain('type="button"');
  });

  it("one polite live region for the files, present from the first paint", () => {
    expect(html).toMatch(/<div[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/div>|<div[^>]*aria-live="polite"[^>]*role="status"[^>]*><\/div>/);
  });

  it("the upload control: a button and a drop zone; the file input is never posted with the decision", () => {
    expect(t).toContain("Choose files");
    expect(t).toContain("Drag files here, or");
    const input = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain("multiple");
    expect(input).toContain('accept="');
    expect(input).not.toMatch(/\sname=/);
    expect(html).toContain('aria-label="Drop or paste files here"');
  });

  it("the request details state the files the participant will receive", () => {
    expect(t).toContain("Files 4 files, 5.9 MB in all They open them with the question. Emails to them never carry files.");
    expect(text(render([leafletPdf]))).toContain("Files 1 file, 2.4 MB They open");
    expect(text(render([]))).toContain("Files None");
  });
});

describe("Send gating (spec 'Send waits for checking', 'Refused file blocks Send until removed')", () => {
  it("while files upload or are checked, Send is unavailable and points at the reason next to it", () => {
    for (const [files, reason] of [
      [[leafletPdf, photoUploading], f.gateUploading],
      [[leafletPdf, readingsCsv], f.gateChecking],
    ] as const) {
      const html = render([...files]);
      const send = sendTag(html);
      expect(send).toContain("disabled");
      const ids = describedBy(send);
      expect(ids.map((id) => byId(html, id))).toContain(reason);
    }
  });

  it("a listed refused file keeps Send unavailable until it is removed", () => {
    const one = render([leafletPdf, refusedFiles.type]);
    expect(sendTag(one)).toContain("disabled");
    expect(describedBy(sendTag(one)).map((id) => byId(one, id))).toContain("Remove the refused file to send.");
    const two = render([refusedFiles.type, refusedFiles.malware, readingsCsv]);
    expect(describedBy(sendTag(two)).map((id) => byId(two, id))).toContain("Remove the 2 refused files to send.");
    const removed = render([leafletPdf]);
    expect(sendTag(removed)).not.toContain("disabled");
    expect(describedBy(sendTag(removed))).toEqual([]);
  });

  it("the gating line and the question error both explain Send when both apply", () => {
    const html = render([readingsCsv], "awaiting", { question: "" });
    const texts = describedBy(sendTag(html)).map((id) => byId(html, id));
    expect(texts).toContain(f.gateChecking);
    expect(texts.some((s) => s.includes("Write a question to send it."))).toBe(true);
  });

  it("Don't send stays available whatever the files", () => {
    const html = render([refusedFiles.malware, photoUploading]);
    const dont = /<button[^>]*value="dont_send"[^>]*>/.exec(html)?.[0] ?? "";
    expect(dont).not.toContain("disabled");
  });
});

describe("refusal reasons: plain, short, never naming a detection", () => {
  const expected: Record<ApprovalFileRefusal, string> = {
    type: "This type of file can't be sent. Allowed: PDF, PNG, JPEG, WebP, plain text, CSV or Markdown.",
    size: "This file is over 25 MB, the most for one file.",
    total: "With this file the request would be over 50 MB, the most for all files together.",
    count: "A request can have 5 files at most. Remove one, then add this file again.",
    malware: "The security check refused this file, so it has been deleted.",
    not_checked: "The check did not finish in time, so this file can't be sent. Remove it and add it again.",
    upload_failed: "The upload did not finish. Remove it and add it again.",
  };
  for (const [reason, sentence] of Object.entries(expected)) {
    it(reason, () => {
      const t = text(render([refusedFiles[reason as ApprovalFileRefusal]]));
      expect(t).toContain(`${refusedFiles[reason as ApprovalFileRefusal].name}`);
      expect(t).toContain("Refused");
      expect(t).toContain(sentence);
    });
  }
  it("no copy names a detection, a scanner or a threat", () => {
    // Values only: the keys are the protocol's reason codes, never shown.
    const values = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(values) : []);
    expect(values(copy).join("\n")).not.toMatch(/virus|malware|eicar|trojan|threat|infect|guardduty|clamav|detection/i);
  });
  it("a refused file offers Remove, never Open", () => {
    const html = render([refusedFiles.malware]);
    expect(html).toContain('aria-label="Remove notes.txt"');
    expect(html).not.toContain('aria-label="Open notes.txt"');
  });
});

describe("the upload control's limits and unavailable states", () => {
  it("with 5 files listed, adding is unavailable and the page says why", () => {
    const five = [leafletPdf, chartPng, notesMd, readingsCsv, { ...leafletPdf, id: "x", name: "annex.pdf" }];
    const html = render(five);
    expect(text(html)).toContain("5 files is the most a request can have. Remove one to add another.");
    expect(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Choose files/.exec(html)?.[0]).toContain("disabled");
  });
  it("offline: adding needs a connection", () => {
    const html = render([leafletPdf], "offline");
    expect(text(html)).toContain("Adding files needs a connection.");
    expect(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Choose files/.exec(html)?.[0]).toContain("disabled");
  });
  it("while a decision is recorded, files cannot be added or removed", () => {
    for (const state of ["sending", "not-sending"] as const) {
      const html = render([leafletPdf], state);
      expect(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Choose files/.exec(html)?.[0]).toContain("disabled");
      expect(buttonTags(html).find((b) => b.includes('aria-label="Remove when_to_call_v3.pdf"'))).toContain("disabled");
    }
  });
  it("a file being removed says so and cannot be pressed twice", () => {
    const html = render([{ ...leafletPdf, removing: true }]);
    const remove = buttonTags(html).find((b) => b.includes('aria-label="Remove when_to_call_v3.pdf"')) ?? "";
    expect(remove).toContain("disabled");
    expect(text(remove)).toContain("Removing…");
  });
});

describe("refusals at Send with files", () => {
  it("outside the participant's rules, with files: says files may be the cause, without naming their rule", () => {
    const t = text(render([leafletPdf], "refused", { refusal: "outside_participant_rules" }));
    expect(t).toContain(f.rulesWithFiles.title);
    expect(t).toContain("Remove the files and try Send again");
    expect(t).toContain("Nothing was sent and nothing is held.");
    expect(t).not.toMatch(/MB the participant|their limit is|they accept up to/);
    // Without files the M2 wording stands.
    expect(text(render([], "refused", { refusal: "outside_participant_rules" }))).toContain(copy.approval.refused.outside_participant_rules.body);
  });
  it("files not ready at Send (a file changed state in between)", () => {
    const t = text(render([leafletPdf, readingsCsv], "refused", { refusal: "files_not_ready" }));
    expect(t).toContain(f.notReady.title);
    expect(t).toContain("Nothing was sent and nothing is held.");
  });
});

describe("after the decision", () => {
  it("sent: the files are listed with the question as sent, can be opened, not added or removed (spec 'Files on a sent request')", () => {
    for (const state of ["sent", "already-sent"] as const) {
      const html = render([leafletPdf, chartPng], state, { decidedAt: "2026-11-03T10:24:00+01:00" });
      const t = text(html);
      expect(t.indexOf("Files sent with it")).toBeGreaterThan(t.indexOf("The question as sent"));
      expect(t).toContain("when_to_call_v3.pdf PDF · 2.4 MB");
      expect(html).toContain('aria-label="Open when_to_call_v3.pdf"');
      expect(html).not.toMatch(/aria-label="Remove|Choose files|type="file"/);
      expect(t).not.toMatch(/\bReady\b/);
    }
  });
  it("sent without files: no files section", () => {
    expect(text(render([], "sent", { decidedAt: "2026-11-03T10:24:00+01:00" }))).not.toContain("Files sent with it");
  });
  it("not sent with files: says they will be deleted within the hour", () => {
    expect(text(render([leafletPdf], "not-sent"))).toContain("The files you added will be deleted within the hour.");
    expect(text(render([], "not-sent"))).not.toContain("files you added");
  });
  it("expired and wrong principal show nothing about files", () => {
    for (const state of ["expired", "wrong-principal"] as const) {
      const t = text(render([leafletPdf], state));
      expect(t).not.toMatch(/when_to_call|Files/);
    }
  });
});

describe("pages that pass no files keep the M2 approval page as it was", () => {
  it("no files section, no Files fact", () => {
    const t = text(renderToStaticMarkup(<ApprovalScreen email={principalEmail} timeZone={storyTimeZone} now={storyNow} request={approvalRequest} />));
    expect(t).not.toMatch(/Files they will consult|Choose files|\bFiles None/);
  });
});
