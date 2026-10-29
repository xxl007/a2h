// Arranging requests the way apps/mcp creates them (a `requests` row in
// `sent` and its first event), and moving them along the lifecycle as the
// participant would, directly in the database. Test-only.
import type pg from "pg";
import { importPrivateKey, signAnswer, type AnswerEnvelope, type Intent, type UnsignedAnswer } from "@a2h/protocol";
import type { WorkerConfig } from "../../src/config.ts";
import { PRINCIPAL_ID } from "./stage-db.ts";

let counter = 0x100 + Math.floor(Math.random() * 0x800);

/** A fresh request id `A2H-xxxx`, unique within a test process. */
export function nextRequestId(): string {
  counter += 1;
  return `A2H-${counter.toString(16).padStart(4, "0")}`;
}

export interface NewRequest {
  handle: string;
  intent?: Intent;
  bid_minor?: number;
  /** Seconds from now; negative for a request already past its expiry. */
  expires_in?: number;
  /** Seconds from now (default: due now). */
  deliver_in?: number;
  status?: "sent" | "accepted";
  question?: string;
  options?: { id: string; label: string }[];
  principal_id?: string;
}

export const DATA_TERMS = { storage: "principal_workspace", attribution: "not_attributed", training: "off" } as const;

export async function createRequest(admin: pg.Client, r: NewRequest): Promise<{ id: string; participant_id: string }> {
  const id = nextRequestId();
  const { rows } = await admin.query<{ id: string }>(`SELECT id FROM participants WHERE handle = $1`, [r.handle]);
  const participant_id = rows[0]?.id;
  if (!participant_id) throw new Error(`no participant ${r.handle}`);
  await admin.query(
    `INSERT INTO requests (id, principal_id, participant_id, intent, audience, time_shape, format, lane, question, options,
       data_terms, bid_minor, currency, deliver_at, expires_at)
     VALUES ($1, $2, $3, $4, 'named_individual', 'one_shot', 'single_field', 'paid', $5, $6, $7, $8, 'EUR',
       now() + make_interval(secs => $9), now() + make_interval(secs => $10))`,
    [
      id,
      r.principal_id ?? PRINCIPAL_ID,
      participant_id,
      r.intent ?? "judgment",
      r.question ?? "Would a patient find this leaflet alarming?",
      r.options ? JSON.stringify(r.options) : null,
      JSON.stringify(DATA_TERMS),
      r.bid_minor ?? 3500,
      r.deliver_in ?? 0,
      r.expires_in ?? 7 * 24 * 3600,
    ],
  );
  await admin.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, NULL, 'sent', 'principal')`, [id]);
  if (r.status === "accepted") await accept(admin, id);
  return { id, participant_id };
}

export async function accept(admin: pg.Client, id: string): Promise<void> {
  await admin.query(`UPDATE requests SET status = 'accepted' WHERE id = $1`, [id]);
  await admin.query(`INSERT INTO request_events (request_id, from_status, to_status, actor) VALUES ($1, 'sent', 'accepted', 'participant')`, [id]);
}

export async function statusOf(admin: pg.Client, id: string): Promise<string> {
  return (await admin.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [id])).rows[0]!.status;
}

export async function eventsOf(admin: pg.Client, id: string): Promise<{ from_status: string | null; to_status: string; actor: string; reason_code: string | null }[]> {
  return (
    await admin.query(`SELECT from_status, to_status, actor, reason_code FROM request_events WHERE request_id = $1 ORDER BY id`, [id])
  ).rows as { from_status: string | null; to_status: string; actor: string; reason_code: string | null }[];
}

export async function answerCount(admin: pg.Client, id: string): Promise<number> {
  return (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM answers WHERE request_id = $1`, [id])).rows[0]!.n;
}

/** A complete, signed judgment envelope for `request_id`, signed with `key`. */
export async function signedEnvelope(
  key: WorkerConfig["signing"],
  fields: Pick<UnsignedAnswer, "request_id" | "participant_id"> & Partial<UnsignedAnswer>,
): Promise<AnswerEnvelope> {
  const unsigned: UnsignedAnswer = {
    body: { verdict: "yes", note: { text: "Reads as calm and factual." } },
    confidence: 4,
    answered_personally: true,
    signed_at: "2026-10-21T09:10:00+02:00",
    ...fields,
  };
  const signature = await signAnswer(unsigned, await importPrivateKey(key.private_key_pkcs8));
  return { ...unsigned, key_id: key.key_id, signature };
}
