import type { ConnectedClient } from "./components/ClientRow.js";
import type { ApprovalRequest } from "./screens/ApprovalScreen.js";
import type { ClientSummary } from "./components/types.js";

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
