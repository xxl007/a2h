// A stage schema with the simulated participants (packages/db/seed/seed.sql,
// as db-migrate.sh applies it on a preview) and helpers that record
// awaiting-approval requests the way `request_human` does
// (`createAwaitingRequest`, m2-approval-page D1), for the approval page tests.
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { approvalTokenHash, formatApprovalToken, type Manifest } from "@a2h/protocol";
import { createAwaitingRequest, ensurePrincipal, findPublishedParticipant, type A2hDb } from "@a2h/db";
import { createStageSchema } from "./postgres";

const SEED = new URL("../../../../packages/db/seed/seed.sql", import.meta.url).pathname;

export const POLICY = {
  currency: "EUR",
  monthly_budget_minor: 50_000,
  per_request_cap_minor: 6_000,
  ask_first_above_minor: null,
  daily_request_limit: 50,
  throttled_daily_limit: 5,
};

export interface ApprovalDb {
  pool: pg.Pool;
  db: A2hDb;
  sql: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
  close(): Promise<void>;
}

export async function startApprovalDb(adminUrl: string, schema: string): Promise<ApprovalDb> {
  const url = await createStageSchema(adminUrl, schema);
  const seed = new pg.Client({ connectionString: url });
  await seed.connect();
  try {
    await seed.query("BEGIN");
    await seed.query(`SELECT set_config('a2h.stage', 'test', true)`);
    for (const s of readFileSync(SEED, "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await seed.query(s);
    await seed.query("COMMIT");
  } finally {
    await seed.end();
  }
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const db = drizzle(pool) as unknown as A2hDb;
  return {
    pool,
    db,
    sql: async <T,>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[],
    close: () => pool.end(),
  };
}

export async function principal(d: ApprovalDb, id: string, policy: Partial<typeof POLICY> = {}): Promise<string> {
  await ensurePrincipal(d.db, id, { policy: { ...POLICY, ...policy } });
  return id;
}

export const DRAFT = "Would a patient with type 2 diabetes find the leaflet's section on insulin alarming?";

export function manifest(principalId: string, over: Partial<Manifest> = {}): Manifest {
  return {
    to: "sim-mv-7f3c",
    intent: "judgment",
    audience: "named_individual",
    time_shape: "one_shot",
    format: "single_field",
    question: DRAFT,
    lane: "paid",
    bid_minor: 3500,
    currency: "EUR",
    expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    data_terms: { storage: "principal_workspace", attribution: "not_attributed", training: "off" },
    principal_id: principalId,
    ...over,
  };
}

let n = 0;
export interface Awaiting {
  id: string;
  token: string;
}

export async function awaiting(
  d: ApprovalDb,
  principalId: string,
  over: { manifest?: Partial<Manifest>; approvalExpiresAt?: Date; now?: Date } = {},
): Promise<Awaiting> {
  n += 1;
  const id = `A2H-${(0xb000 + n + Math.floor(Math.random() * 0x4000)).toString(16)}`;
  const token = formatApprovalToken(crypto.getRandomValues(new Uint8Array(32)));
  const m = manifest(principalId, over.manifest);
  const p = await findPublishedParticipant(d.db, m.to);
  if (!p) throw new Error(`no participant ${m.to}`);
  const now = over.now ?? new Date();
  await createAwaitingRequest(d.db, {
    id,
    manifest: m,
    participant_id: p.participant_id,
    deliver_at: now,
    approval_token_hash: await approvalTokenHash(token),
    approval_expires_at: over.approvalExpiresAt ?? new Date(now.getTime() + 24 * 3_600_000),
    now,
  });
  return { id, token };
}

export async function stored(d: ApprovalDb, id: string) {
  const [r] = await d.sql<{ status: string; question: string; not_sent_reason: string | null }>("SELECT status, question, not_sent_reason FROM requests WHERE id = $1", [id]);
  return r;
}

export async function events(d: ApprovalDb, id: string): Promise<number> {
  const [r] = await d.sql<{ n: string }>("SELECT count(*) AS n FROM request_events WHERE request_id = $1", [id]);
  return Number(r!.n);
}
