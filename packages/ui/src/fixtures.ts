import type { ConnectedClient } from "./components/ClientRow.js";
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
