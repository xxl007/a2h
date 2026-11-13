import type { ConnectedClient } from "./components/ClientRow.js";
import type { ApprovalRequest } from "./screens/ApprovalScreen.js";
import type { ClientSummary } from "./components/types.js";
import type { ApprovalFile, ApprovalFileRefusal, ApprovalFileRules } from "./components/FileList.js";

/** Story fixtures. Addresses use the reserved example.com domain. */
export const principalEmail = "galem@example.com";

export const claudeAi: ClientSummary = { id: "c-claude-ai", name: "Claude", origin: "claude.ai", registration: "metadata-document" };
export const claudeCode: ClientSummary = { id: "c-claude-code", name: "Claude Code", origin: "localhost", registration: "dynamic" };
export const preRegistered: ClientSummary = { id: "c-chatgpt", name: "ChatGPT", origin: "chatgpt.com", registration: "pre-registered" };
export const longName: ClientSummary = {
  id: "c-long",
  name: "Research assistant for the clinical documentation team, workspace Glucomate EU",
  origin: "agents.research-tools.example.com",
  registration: "dynamic",
};

export const connectedClients: ConnectedClient[] = [
  { ...claudeAi, connectedAt: { iso: "2026-10-28T09:12:00Z", label: "28 Oct 2026" }, lastUsedAt: { iso: "2026-10-30T14:02:00Z", label: "today, 14:02" } },
  { ...claudeCode, connectedAt: { iso: "2026-10-29T17:40:00Z", label: "29 Oct 2026" }, lastUsedAt: { iso: "2026-10-29T18:05:00Z", label: "29 Oct 2026, 18:05" } },
  { ...preRegistered, connectedAt: { iso: "2026-10-30T08:00:00Z", label: "today" }, lastUsedAt: null },
];

// ---- m2-approval-page ----------------------------------------------------------------------

/** The agent's draft, with a paragraph break (line breaks are kept byte for byte). */
export const agentDraft =
  'Below is the "When to call your doctor" section of a first-use leaflet for a home glucose monitor (EU, reading age 12). Would a newly diagnosed patient find this wording alarming? If so, which sentence, and how would you soften it without losing the safety message?\n\nLeaflet text: "If your reading is above 13.9 mmol/L twice in a row, call your doctor the same day. If you feel confused or very thirsty, call 112."';

/** Paid judgment request to a simulated participant, delivered now. Times are in UTC+01:00. */
export const approvalRequest: ApprovalRequest = {
  id: "A2H-7f3c",
  participant: { label: "Margaret Vale (simulated)", handle: "sim-mv-7f3c", simulated: true },
  intent: "judgment",
  format: "single_field",
  money: { lane: "paid", hold: "€35.00", feeRate: "15%", fee: "€5.25", net: "€29.75" },
  expiresAt: "2026-11-04T12:20:00+01:00",
  dataTerms: { attribution: "not_attributed", training: "off" },
  agentDraft,
  questionMaxLength: 2000,
  approvalExpiresAt: "2026-11-04T10:20:00+01:00",
};

/** Opinion poll with options and a scale, free lane, delivery deferred by quiet hours. */
export const pollRequest: ApprovalRequest = {
  id: "A2H-2b9e",
  participant: { label: "Ann Bright (simulated)", handle: "sim-ab-1234", simulated: true },
  intent: "opinion",
  format: "poll",
  options: [
    { id: "a", label: "The fox in the rain (cover A)" },
    { id: "b", label: "Night garden, «lanterns» & owls — cover B" },
    { id: "c", label: "A quiet street at dusk (cover C)" },
  ],
  scale: { min: 1, max: 7 },
  money: { lane: "free", freeLane: "own_publications" },
  expiresAt: "2026-11-05T18:00:00+01:00",
  dataTerms: { attribution: "attributed", training: "participant_opt_in" },
  deliverAt: "2026-11-04T08:00:00+01:00",
  agentDraft: "Which cover would make you pick up your own new picture book in a shop, and how strongly (1 to 7)?",
  questionMaxLength: 2000,
  approvalExpiresAt: "2026-11-04T22:15:00+01:00",
};

/** A real (not simulated) participant, for the variant without the simulated note. */
export const realParticipantRequest: ApprovalRequest = {
  ...approvalRequest,
  id: "A2H-9c1d",
  participant: { label: "Marieke V.", handle: "mv-7f3c", simulated: false },
};

/** Stories show times in Paris so the offset is visible; pages use the viewer's zone. */
export const storyTimeZone = "Europe/Paris";
/** The stories' clock: 1 h 50 min before approvalRequest's link ends, so the validity line is absent. */
export const storyNow = "2026-11-04T08:30:00+01:00";
/** 45 min before approvalRequest's link ends: the validity line shows (A1, link ends within the hour). */
export const storyNowLinkEnding = "2026-11-04T09:35:00+01:00";

/** Stress case: labels with quotes, guillemets, mixed scripts and a long unbroken word (story only). */
export const pollStressRequest: ApprovalRequest = {
  ...pollRequest,
  id: "A2H-5e0a",
  options: [
    { id: "a", label: "“Cover A” — the fox in the rain" },
    { id: "b", label: "Night garden, «lanterns» & owls — cover B" },
    { id: "c", label: "封面 C：黄昏的安静街道" },
    { id: "d", label: "Supercalifragilisticexpialidocious-cover-D-with-a-very-long-unbroken-label" },
  ],
};

// ---- m2-attachments ------------------------------------------------------------------------

/** The limits and types packages/protocol fixes (proposal decisions 1 and 3); the app passes its constants. */
export const fileRules: ApprovalFileRules = {
  accept: ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "text/markdown"],
  maxFiles: 5,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

const MB = 1024 * 1024;
export const leafletPdf: ApprovalFile = { id: "f-pdf", name: "when_to_call_v3.pdf", mediaType: "application/pdf", sizeBytes: Math.round(2.4 * MB), state: "ready" };
export const chartPng: ApprovalFile = { id: "f-png", name: "glucose-thresholds-chart.png", mediaType: "image/png", sizeBytes: 418 * 1024, state: "ready" };
export const readingsCsv: ApprovalFile = { id: "f-csv", name: "readings_week_42.csv", mediaType: "text/csv", sizeBytes: 36 * 1024, state: "checking" };
export const photoUploading: ApprovalFile = { id: "f-jpg", name: "IMG_2041.jpg", mediaType: "image/jpeg", sizeBytes: Math.round(3.1 * MB), state: "uploading", progress: 0.42 };
export const notesMd: ApprovalFile = { id: "f-md", name: "reviewer-notes.md", mediaType: "text/markdown", sizeBytes: 3 * 1024, state: "ready" };

/** One refused file per reason (design.md, Screens F5). */
export const refusedFiles: Record<ApprovalFileRefusal, ApprovalFile> = {
  type: { id: "r-type", name: "leaflet-source.zip", mediaType: "application/zip", sizeBytes: Math.round(1.2 * MB), state: "refused", refusal: "type" },
  size: { id: "r-size", name: "clinic-walkthrough-scan.pdf", mediaType: "application/pdf", sizeBytes: Math.round(31.5 * MB), state: "refused", refusal: "size" },
  total: { id: "r-total", name: "annex-b-full.pdf", mediaType: "application/pdf", sizeBytes: Math.round(19 * MB), state: "refused", refusal: "total" },
  count: { id: "r-count", name: "photo-6.jpg", mediaType: "image/jpeg", sizeBytes: Math.round(1.8 * MB), state: "refused", refusal: "count" },
  malware: { id: "r-malware", name: "notes.txt", mediaType: "text/plain", sizeBytes: 68, state: "refused", refusal: "malware" },
  not_checked: { id: "r-unchecked", name: "patient-diary-template.pdf", mediaType: "application/pdf", sizeBytes: Math.round(4.2 * MB), state: "refused", refusal: "not_checked" },
  upload_failed: { id: "r-failed", name: "IMG_2042.jpg", mediaType: "image/jpeg", sizeBytes: Math.round(2.9 * MB), state: "refused", refusal: "upload_failed" },
};

/**
 * `not_checked` on a file that is not a PDF: the reason drops the password sentence and ends
 * "Remove it and add it again." (fix after m2-attachments Gate 2; the PDF wording is unchanged).
 */
export const notCheckedText: ApprovalFile = { id: "r-unchecked-txt", name: "visit-notes.txt", mediaType: "text/plain", sizeBytes: 12 * 1024, state: "refused", refusal: "not_checked" };

// ---- m2-org-sign-in ------------------------------------------------------------------------

import type { Person, RecordEntry } from "./components/people.js";

const someone = (id: string, name: string, email: string, over: Partial<Person> = {}): Person => ({
  id,
  name,
  email,
  hasAccess: true,
  isAdministrator: false,
  isYou: false,
  namedInConfiguration: false,
  administratorOnRestore: false,
  ...over,
});

/** The viewer: an administrator named in the install's configuration. */
export const personYou = someone("u-galem", "Galem L.", principalEmail, { isYou: true, isAdministrator: true, namedInConfiguration: true });
export const personIlse = someone("u-ilse", "Ilse de Boer", "ilse.deboer@example.com");
export const personMarieke = someone("u-marieke", "Marieke Visser", "marieke.visser@example.com", { isAdministrator: true });
export const personPriya = someone("u-priya", "Priya Nair", "priya.nair@example.com", { hasAccess: false });
export const personSanne = someone("u-sanne", "Sanne Kok", "sanne.kok@example.com");
export const personTom = someone("u-tom", "Tom Aubert", "tom.aubert@example.com");
export const personHanna = someone("u-hanna", "Hanna Lind", "hanna.lind@example.com", { isAdministrator: true, namedInConfiguration: true });

/** Six people, every kind of row, sorted by name (screens.md P1). Invented names, example.com addresses. */
export const people: Person[] = [personYou, personIlse, personMarieke, personPriya, personSanne, personTom];

const FIRST = ["Aisha", "Anouk", "Bram", "Chloé", "Daan", "Elif", "Emma", "Farid", "Hugo", "Ines", "Jules", "Kenji", "Lea", "Lucas", "Maya", "Noor", "Omar", "Pieter", "Rosa", "Sofia", "Thijs", "Yara"];
const LAST = ["Bakker", "Bernard", "Dubois", "Haddad", "Jansen", "Kaya", "Laurent", "Martin", "Okafor", "Peeters", "Rossi", "Smit", "Tanaka"];

/** 214 generated people for the long list (screens.md P5): 213 and the viewer. */
export const manyPeople: Person[] = (() => {
  const many: Person[] = [];
  for (let i = 0; many.length < 213; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]!;
    const name = `${first} ${last}`;
    if (many.some((m) => m.name === name)) continue;
    const n = many.length;
    const address = `${first}.${last}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "") + "@example.com";
    many.push(someone(`u-${n}`, name, address, { hasAccess: n % 43 !== 5, isAdministrator: n === 30 || n === 120 }));
  }
  many.push(personYou);
  return many.sort((a, b) => a.name.localeCompare(b.name, "en"));
})();

const galem = { name: personYou.name, email: personYou.email };
const marieke = { name: personMarieke.name, email: personMarieke.email };
const tom = { name: personTom.name, email: personTom.email };
const sanne = { name: personSanne.name, email: personSanne.email };
const priya = { name: personPriya.name, email: personPriya.email };

/** Newest first (screens.md P14). Times are in UTC+01:00. */
export const recordEntries: RecordEntry[] = [
  { id: "act-7", action: "access_removed", by: galem, about: sanne, at: "2026-11-11T14:02:00+01:00" },
  { id: "act-6", action: "access_restored", by: marieke, about: priya, at: "2026-11-11T11:47:00+01:00" },
  { id: "act-5", action: "administrator_withdrawn", by: marieke, about: tom, at: "2026-11-10T09:15:00+01:00" },
  { id: "act-4", action: "access_removed", by: galem, about: priya, at: "2026-11-09T16:30:00+01:00" },
  { id: "act-3", action: "administrator_withdrawn", by: tom, about: tom, at: "2026-11-09T16:02:00+01:00" },
  { id: "act-2", action: "administrator_made", by: galem, about: marieke, at: "2026-11-09T10:05:00+01:00" },
  { id: "act-1", action: "administrator_made", by: galem, about: tom, at: "2026-11-09T10:04:00+01:00" },
];
