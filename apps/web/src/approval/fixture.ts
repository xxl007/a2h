// Test data for the approval page's e2e flows on a preview (m2-approval-page
// task 5.4), until `request_human` returns the link (group 3) and the flows
// can create requests through it. POST /test-fixtures/approval records one
// awaiting-approval request the way request_human does: the manifest is
// validated with the shared loaders (packages/db approvalFacts, protocol
// validateManifest), nothing is held or delivered, the token is stored as
// its hash and returned once in the response (never logged).
//
// Bounds: non-production stages only (prod answers 404, as the CIMD test
// documents do); the signed-in principal only (no principal id in the
// body); simulated participants only (fixed handles, `sim-`). Sending it
// still takes the principal's own Send on the page.
import {
  approvalTokenHash,
  ApprovalTokenSchema,
  formatApprovalToken,
  formatRequestId,
  validateManifest,
  type Manifest,
} from "@a2h/protocol";
import {
  approvalFacts,
  createAwaitingRequest,
  ensurePrincipal,
  findPublishedParticipant,
  RequestIdTaken,
  type A2hDb,
  type PrincipalPolicy,
} from "@a2h/db";
import * as z from "zod";
import type { Logger } from "../log";

export const FIXTURE_APPROVAL_PATH = "/test-fixtures/approval";

export interface FixtureDeps {
  stage: string;
  db: A2hDb;
  feeRate: number;
  /** The stage's default policy, given at first consent (the QA principal may not have consented on a fresh preview). */
  defaultPolicy: PrincipalPolicy;
  /** The web app's origin, for the link. */
  baseURL: string;
  /** The signed-in session's principal, or undefined. */
  principalId: () => Promise<string | undefined>;
  logger: Logger;
  now?: () => Date;
}

/** `ending`: a paid request whose link has half an hour left, for the validity line (design.md decision bar). */
const BodySchema = z.strictObject({ variant: z.enum(["paid", "poll", "expired", "ending"]).default("paid") });
type Variant = z.infer<typeof BodySchema>["variant"];

export const FIXTURE_QUESTION = "Would a patient newly diagnosed with type 2 diabetes find the leaflet's section on insulin alarming?";

/**
 * The poll goes to the first of these whose rules take it now: three
 * simulated participants accept opinions at €10.00 gross, so the flows'
 * Sends spread over three daily interruption limits (10 each, seed).
 */
const POLL_PARTICIPANTS = ["sim-jw-9e48", "sim-cf-4c5e", "sim-ep-5c07"] as const;

function manifestFor(variant: Variant, principalId: string, now: Date, to?: string): Manifest {
  const base = {
    audience: "named_individual",
    time_shape: "one_shot",
    lane: "paid",
    currency: "EUR",
    expires_at: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
    data_terms: { storage: "principal_workspace", attribution: "not_attributed", training: "off" },
    principal_id: principalId,
  } as const;
  if (variant === "poll") {
    return {
      ...base,
      to: to ?? POLL_PARTICIPANTS[0],
      intent: "opinion",
      format: "poll",
      question: "Which cover would make you pick this picture book up first?",
      options: [
        { id: "a", label: "The fox in the snow" },
        { id: "b", label: "The lighthouse at night — «blue»" },
        { id: "c", label: "The two hens & the umbrella" },
      ],
      scale: { min: 1, max: 5 },
      bid_minor: 1000,
    };
  }
  return { ...base, to: "sim-mv-7f3c", intent: "judgment", format: "single_field", question: FIXTURE_QUESTION, bid_minor: 3500 };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function handleApprovalFixture(deps: FixtureDeps, request: Request): Promise<Response> {
  if (deps.stage === "prod") return new Response("Not found", { status: 404 });
  const principalId = await deps.principalId();
  if (principalId === undefined) return json(401, { error: "sign in first" });
  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "variant is paid, poll, expired or ending" });
  const variant = parsed.data.variant;

  const now = deps.now?.() ?? new Date();
  const owner = await ensurePrincipal(deps.db, principalId, { policy: deps.defaultPolicy });
  const policy = { ...owner.policy, fee_rate: deps.feeRate };
  let chosen: { manifest: Manifest; participant_id: string; deliver_at: string } | undefined;
  let refusal = "no_simulated_participant";
  for (const to of variant === "poll" ? POLL_PARTICIPANTS : [undefined]) {
    const manifest = manifestFor(variant, principalId, now, to);
    const participant = await findPublishedParticipant(deps.db, manifest.to);
    if (!participant?.simulated) continue;
    const facts = await approvalFacts(deps.db, { principal: owner.principal, currency: policy.currency, participant, now, approval: "recorded" });
    // Not recorded as a block: this is a test helper looking for a participant whose rules take it.
    const v = validateManifest(manifest, facts, policy);
    if (v.ok) {
      chosen = { manifest, participant_id: participant.participant_id, deliver_at: v.deliver_at };
      break;
    }
    refusal = v.error.code;
  }
  if (!chosen) return json(409, { error: refusal });
  const { manifest } = chosen;

  const token = formatApprovalToken(crypto.getRandomValues(new Uint8Array(32)));
  if (!ApprovalTokenSchema.safeParse(token).success) throw new Error("token format");
  const created = variant === "expired" ? new Date(now.getTime() - 2 * 3_600_000) : now;
  const linkExpiry =
    variant === "expired" ? new Date(now.getTime() - 60_000) : variant === "ending" ? new Date(now.getTime() + 30 * 60_000) : new Date(now.getTime() + 24 * 3_600_000);
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = formatRequestId(crypto.getRandomValues(new Uint8Array(2)));
    try {
      await createAwaitingRequest(deps.db, {
        id,
        manifest,
        participant_id: chosen.participant_id,
        deliver_at: new Date(chosen.deliver_at),
        approval_token_hash: await approvalTokenHash(token),
        approval_expires_at: linkExpiry,
        now: created,
      });
      deps.logger.info("approval fixture recorded", { request_id: id, principal_id: principalId, code: `fixture_${variant}` });
      return json(201, { request_id: id, url: `${deps.baseURL}/approve/${id}?t=${token}`, question: manifest.question });
    } catch (e) {
      if (!(e instanceof RequestIdTaken)) throw e;
    }
  }
  return json(503, { error: "no free request id" });
}
