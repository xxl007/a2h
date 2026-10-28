// THROWAWAY SPIKE ONLY, never merge. openspec/changes/m1-protocol-connector
// tasks.md 1.1 (design.md D1). Deleted before task group 2 starts.
//
// `approve_test` proves the 2026-07-28 multi-round-trip approval with an
// HMAC-protected requestState on a stateless, multi-instance server.
import { createHash, randomUUID } from "node:crypto";
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod";

// THROWAWAY SPIKE ONLY, never merge: a fixed HMAC key in source, because the
// preview has no `a2h/pr-<n>/approval` secret yet. The real change reads the
// key from Secrets Manager (tasks.md 6.1). It must be the same on every
// instance, which a constant trivially is.
const SPIKE_HMAC_KEY = "a2h-spike-THROWAWAY-never-merge-0123456789abcdef";

/** What the state carries. No question text: only its hash. */
export interface ApprovalState {
  principal_id: string;
  manifest_hash: string;
  nonce: string;
  issued_at: string;
}

const APPROVAL_KEY = "approval";

// D1: 15 minutes. The codec adds `exp` and refuses the state after it.
export const approvalCodec = createRequestStateCodec<ApprovalState>({
  key: SPIKE_HMAC_KEY,
  ttlSeconds: 15 * 60,
});

function manifestHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function conflict(detail: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `conflict: ${detail}` }],
  };
}

export function registerApproveTest(server: McpServer, stage: string): void {
  server.registerTool(
    "approve_test",
    {
      description:
        "THROWAWAY SPIKE (do not use in production). Asks the user to approve, and optionally edit, " +
        "the given text through a form dialog pre-filled with it, then returns the approved text. " +
        "Nothing is sent anywhere.",
      inputSchema: z.object({ text: z.string().min(1).max(2000) }),
    },
    async ({ text }, ctx) => {
      const responses = ctx.mcpReq.inputResponses;
      if (responses === undefined) {
        const state = await approvalCodec.mint({
          principal_id: `dev-principal-${stage}`,
          manifest_hash: manifestHash(text),
          nonce: randomUUID(),
          issued_at: new Date().toISOString(),
        });
        return inputRequired({
          inputRequests: {
            [APPROVAL_KEY]: inputRequired.elicit({
              mode: "form",
              message:
                "Spike approval test. Edit the question if needed, then accept to get it back; " +
                "decline to send nothing. Nothing is sent anywhere either way.",
              requestedSchema: {
                type: "object",
                properties: {
                  question: { type: "string", title: "Question", default: text },
                },
                required: ["question"],
              },
            }),
          },
          requestState: state,
        });
      }

      // Retry. The verify hook already refused any state we did not mint
      // (or that expired); here the state is the decoded, verified payload.
      const state = ctx.mcpReq.requestState<ApprovalState>();
      if (state === undefined) return conflict("approval state missing");
      if (state.manifest_hash !== manifestHash(text)) {
        return conflict("approval state does not match this request");
      }

      const answer = inputResponse(responses, APPROVAL_KEY);
      if (answer.kind !== "elicit") return conflict("approval response missing");
      if (answer.action !== "accept") {
        return {
          content: [{ type: "text" as const, text: `Not sent (${answer.action}): nothing was created.` }],
        };
      }
      const approved = answer.content?.["question"];
      if (typeof approved !== "string" || approved.length === 0) {
        return conflict("approved question missing or empty");
      }
      return {
        content: [
          { type: "text" as const, text: approved },
          {
            type: "text" as const,
            text: JSON.stringify({
              approved: true,
              state_verified: true,
              edited: approved !== text,
              manifest_hash: state.manifest_hash,
              nonce: state.nonce,
              issued_at: state.issued_at,
            }),
          },
        ],
      };
    },
  );
}
