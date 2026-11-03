// THROWAWAY SPIKE ONLY, never merged. openspec/changes/m2-approval-page
// tasks.md 1.1 (design D3). `approval_link_spike` asks the client to open a
// static page on the stage's web host through a 2026-07-28 `input_required`
// URL-mode elicitation when the client declared `elicitation.url`, and puts
// the link in the result text otherwise. It creates nothing and sends
// nothing. Per call it logs the protocol version, the declared elicitation
// modes, the client's name and version, and the outcome of the retry
// (accept / decline / cancel / none): no arguments, bodies or personal data.
import { randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  inputRequired,
  inputResponse,
  type McpServer,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { A2hSession } from "./session.ts";
import { httpRequestId } from "./tools/common.ts";

const KEY = "approval";
const MODERN = "2026-07-28";

interface Declared {
  version: string;
  form: boolean;
  url: boolean;
  declared: boolean;
  clientName: string | undefined;
  clientVersion: string | undefined;
}

function declared(ctx: ServerContext): Declared {
  const env = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
  const version = env[PROTOCOL_VERSION_META_KEY];
  const caps = env[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const info = env[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  const e = caps?.elicitation;
  const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : undefined);
  return {
    // A 2025-era call carries no per-request envelope (stateless server: the
    // initialize capabilities are on another request); log what we can.
    version: typeof version === "string" ? version : "2025-era (no envelope)",
    declared: caps !== undefined,
    // An empty `elicitation: {}` means form mode (the original elicitation).
    form: e !== undefined && (e.form !== undefined || e.url === undefined),
    url: e?.url !== undefined,
    clientName: short(info?.name),
    clientVersion: short(info?.version),
  };
}

function webOriginOf(issuer: string): string {
  return new URL(issuer).origin;
}

export function registerApprovalLinkSpike(server: McpServer, session: A2hSession, issuer: string): void {
  const origin = webOriginOf(issuer);
  server.registerTool(
    "approval_link_spike",
    {
      description:
        "THROWAWAY SPIKE for the A2H approval page (do not use for anything else). Takes no arguments, " +
        "creates nothing and sends nothing. If your client supports URL elicitation it asks you to open a " +
        "page on the A2H web host; otherwise it returns the link for you to show to the user.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (ctx) => {
      const d = declared(ctx);
      const log = (round: string, outcome: string, spikeId: string | undefined) =>
        session.log({
          level: "info",
          msg: "url elicitation spike",
          tool: "approval_link_spike",
          round,
          protocol_version: d.version,
          elicitation_declared: d.declared,
          elicitation_form: d.form,
          elicitation_url: d.url,
          client_name: d.clientName,
          client_version: d.clientVersion,
          outcome,
          spike_id: spikeId,
          principal_id: session.caller?.principal_id,
          client_id: session.caller?.client_id,
          http_request_id: httpRequestId(ctx),
        });

      const responses = ctx.mcpReq.inputResponses;
      if (responses === undefined) {
        const spikeId = `spike-${randomBytes(4).toString("hex")}`;
        const url = `${origin}/?approval_spike=${spikeId}`;
        if (d.version >= MODERN && d.url) {
          log("first", "input_required", spikeId);
          return inputRequired({
            inputRequests: {
              [KEY]: inputRequired.elicitUrl({
                message: "Open the A2H approval page to review this request and send it or not (spike: the page is a placeholder).",
                url,
              }),
            },
            // No elicitationId on the 2026-07-28 URL shape: correlation is ours, in the signed state.
            requestState: await session.codec.mint({ principal_id: session.caller?.principal_id ?? "", manifest_hash: spikeId, nonce: spikeId, issued_at: new Date().toISOString() }, ctx),
          });
        }
        log("first", "none", spikeId);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Show this link to the user and ask them to open it: ${url}\n` +
                `(spike ${spikeId}: no URL elicitation on this connection, protocol ${d.version}, ` +
                `elicitation.url ${d.url ? "declared" : "not declared"}. Nothing was created or sent.)`,
            },
          ],
        };
      }

      const state = ctx.mcpReq.requestState<{ nonce: string }>();
      const spikeId = state?.nonce;
      const answer = inputResponse(responses, KEY);
      const outcome = answer.kind === "elicit" ? answer.action : answer.kind === "missing" ? "missing" : `other:${answer.kind}`;
      log("retry", outcome, spikeId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Spike ${spikeId ?? "(no state)"}: the client answered the URL elicitation with "${outcome}". Nothing was created or sent.`,
          },
        ],
      };
    },
  );
}
