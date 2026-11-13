// Who has access and who is an administrator (m2-org-sign-in task 3.3;
// design D7; spec platform/administration). Callers: apps/web, at its gates
// (user creation, session creation, the request gate, the token endpoint,
// consent) and on the administrators' page.
//
// - Access is a column of the account (`user.access_removed_at`, null = has
//   access). Removing it deletes the person's sessions and revokes their live
//   refresh tokens in the same transaction; the account, its provider account
//   and its consents are kept, so restoring access needs no new consent.
// - An administrator is a person with access who is flagged
//   (`user.is_administrator`, set by an administrator's action only) or whose
//   address is named in the install's configuration. The configuration is an
//   argument of every function here: this package reads none.
// - Every action is one transaction: lock, decide, change, record. A refused
//   action writes nothing, and no entry claims it happened.
// - Nothing here reads `user.last_idp_sign_in_at`: the administrators' page
//   cannot show what it is never given.
// - No logging here; callers log ids and refusal codes only, never a name or
//   an address.
//
// Typed over any Drizzle Postgres database, so the same queries run on
// node-postgres, on the Data API driver and inside a caller's transaction.
// One statement at a time on a transaction (the Data API refuses two).
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { account, oauthRefreshToken, session, user } from "../auth-schema.ts";
import { type AdministratorAction, administratorActions } from "../schema.ts";
import type { PrincipalsDb } from "./principals.ts";

/** The provider id of the organisation's identity provider in Better Auth's `account` table (design D1: fixed). */
export const IDP_PROVIDER_ID = "idp";

/** What the access predicate needs to know about an account. */
export interface AccessState {
  /** An administrator removed this person's access. */
  access_removed: boolean;
  /** The person signed in through the organisation's identity provider at least once. */
  has_provider_account: boolean;
}

/** The access state of an account, or null when there is no such account. Reads only. */
export async function accessState(db: PrincipalsDb, userId: string): Promise<AccessState | null> {
  const rows = await db
    .select({ access_removed_at: user.accessRemovedAt, provider_account_id: account.id })
    .from(user)
    .leftJoin(account, and(eq(account.userId, user.id), eq(account.providerId, IDP_PROVIDER_ID)))
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { access_removed: row.access_removed_at !== null, has_provider_account: row.provider_account_id !== null };
}

/**
 * The one predicate every gate asks (design D7): access not removed, and, for
 * people without a provider account (magic-link sign-in, development stages
 * only), on the allow-list. Pure; the caller reads the allow-list.
 */
export function hasAccess(state: AccessState | null, onAllowList: boolean): boolean {
  if (!state || state.access_removed) return false;
  return state.has_provider_account || onAllowList;
}

/** The configured addresses in the form they are compared in: trimmed, lower case, no empty entry. */
function configured(administratorEmails: readonly string[]): string[] {
  return [...new Set(administratorEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
}

const isNamed = (email: string, named: readonly string[]): boolean => named.includes(email.trim().toLowerCase());

interface AdministratorFacts {
  email: string;
  access_removed_at: Date | null;
  is_administrator: boolean;
}

/** Administrator = has access (not removed), and flagged or named in the configuration. */
const administratorNow = (row: AdministratorFacts, named: readonly string[]): boolean =>
  row.access_removed_at === null && (row.is_administrator || isNamed(row.email, named));

/**
 * Whether the account is an administrator now. `administratorEmails` is the
 * install's configuration (`ADMINISTRATOR_EMAILS`), read by the caller at
 * each check: a person named there is an administrator while it names them
 * and they have access; nothing is stored for them.
 */
export async function isAdministrator(db: PrincipalsDb, userId: string, administratorEmails: readonly string[]): Promise<boolean> {
  const [row] = await db
    .select({ email: user.email, access_removed_at: user.accessRemovedAt, is_administrator: user.isAdministrator })
    .from(user)
    .where(eq(user.id, userId));
  return row !== undefined && administratorNow(row, configured(administratorEmails));
}

/** A person on the administrators' page. Deliberately no time of last sign-in or activity, no request, answer or rule. */
export interface Person {
  user_id: string;
  name: string;
  email: string;
  has_access: boolean;
  /** Administrator now: has access, and flagged or named in the configuration. */
  is_administrator: boolean;
  /** The stored flag; kept when access is removed, so restoring access restores the role. */
  administrator_flag: boolean;
  named_in_configuration: boolean;
}

/**
 * Everyone who has signed in, sorted by name (then id). Loaded whole: the
 * page searches in the browser, for up to 1,000 people (design D7). Selects
 * id, name, email, `access_removed_at` and `is_administrator` only.
 */
export async function listPeople(db: PrincipalsDb, administratorEmails: readonly string[]): Promise<Person[]> {
  const named = configured(administratorEmails);
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email, access_removed_at: user.accessRemovedAt, is_administrator: user.isAdministrator })
    .from(user)
    .orderBy(sql`lower(${user.name})`, asc(user.id));
  return rows.map((r) => ({
    user_id: r.id,
    name: r.name,
    email: r.email,
    has_access: r.access_removed_at === null,
    is_administrator: administratorNow(r, named),
    administrator_flag: r.is_administrator,
    named_in_configuration: isNamed(r.email, named),
  }));
}

export interface PersonRef {
  user_id: string;
  name: string;
  email: string;
}

/** One entry of the record of administrator actions. */
export interface AdministratorActionEntry {
  id: number;
  action: AdministratorAction;
  at: Date;
  /** Who did it, with their current name and address (joined from the account; the entry holds ids only). */
  actor: PersonRef;
  /** To whom, likewise. */
  subject: PersonRef;
}

/** The record of administrator actions, newest first. Every administrator may read it; the caller checks that. */
export async function listAdministratorActions(db: PrincipalsDb): Promise<AdministratorActionEntry[]> {
  const actor = alias(user, "actor");
  const subject = alias(user, "subject");
  const rows = await db
    .select({
      id: administratorActions.id,
      action: administratorActions.action,
      at: administratorActions.at,
      actor_id: actor.id,
      actor_name: actor.name,
      actor_email: actor.email,
      subject_id: subject.id,
      subject_name: subject.name,
      subject_email: subject.email,
    })
    .from(administratorActions)
    .innerJoin(actor, eq(actor.id, administratorActions.actor_user_id))
    .innerJoin(subject, eq(subject.id, administratorActions.subject_user_id))
    .orderBy(desc(administratorActions.at), desc(administratorActions.id));
  return rows.map((r) => ({
    id: r.id,
    action: r.action as AdministratorAction,
    at: r.at,
    actor: { user_id: r.actor_id, name: r.actor_name, email: r.actor_email },
    subject: { user_id: r.subject_id, name: r.subject_name, email: r.subject_email },
  }));
}

export interface AdministratorActionInput {
  /** The signed-in person asking; must be an administrator when the action is decided. */
  actor_user_id: string;
  /** The person the action is about. */
  subject_user_id: string;
  /** The install's configuration (`ADMINISTRATOR_EMAILS`), read by the caller. */
  administrator_emails: readonly string[];
  /** The time recorded; this module reads no clock. */
  now: Date;
}

/** Why an action was refused. Codes only: safe to log and to map to a message. */
export type AdministratorRefusal =
  /** The actor is not an administrator now (never was, lost access, or lost the role a moment ago). */
  | "not_administrator"
  /** No account with the subject's id. */
  | "unknown_person"
  /** An administrator cannot remove their own access. */
  | "own_access"
  /** The action would leave the install without an administrator who has access. */
  | "last_administrator"
  /** The subject is named in the configuration and remains an administrator while it names them. */
  | "named_in_configuration"
  /** The role is granted only to a person with access. */
  | "no_access"
  /** The subject is already in the state asked for. */
  | "no_change";

export type AdministratorActionResult = { ok: true } | { ok: false; refusal: AdministratorRefusal };

const refused = (refusal: AdministratorRefusal): AdministratorActionResult => ({ ok: false, refusal });

interface Locked {
  actor: AdministratorFacts & { id: string };
  subject: AdministratorFacts & { id: string };
  named: string[];
  /** Administrators with access other than the subject, after the lock. */
  othersRemaining: number;
}

/**
 * One administrator action, in one transaction (a savepoint inside the
 * caller's): take the lock, read the administrators' rows, decide, change,
 * record. The lock is twofold: a transaction-scoped advisory lock that
 * serialises every administrator action of this schema, so the decision
 * (own access, last administrator, the actor still being one) is made on
 * rows no concurrent action can change, and `FOR UPDATE` on the rows of
 * every administrator, the actor and the subject, in id order, so that no
 * other writer changes them under the decision either. Released at commit
 * or rollback.
 */
async function administratorAction(
  db: PrincipalsDb,
  input: AdministratorActionInput,
  action: AdministratorAction,
  decide: (locked: Locked) => AdministratorRefusal | null,
  change: (tx: PrincipalsDb) => Promise<void>,
): Promise<AdministratorActionResult> {
  const named = configured(input.administrator_emails);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('a2h.administrator_actions.' || current_schema())::bigint)`);
    const ids = [...new Set([input.actor_user_id, input.subject_user_id])];
    const rows = await tx
      .select({ id: user.id, email: user.email, access_removed_at: user.accessRemovedAt, is_administrator: user.isAdministrator })
      .from(user)
      .where(or(eq(user.isAdministrator, true), inArray(user.id, ids), named.length > 0 ? inArray(sql`lower(${user.email})`, named) : undefined))
      .orderBy(asc(user.id))
      .for("update");
    const actor = rows.find((r) => r.id === input.actor_user_id);
    if (!actor || !administratorNow(actor, named)) return refused("not_administrator");
    const subject = rows.find((r) => r.id === input.subject_user_id);
    if (!subject) return refused("unknown_person");
    const othersRemaining = rows.filter((r) => r.id !== subject.id && administratorNow(r, named)).length;
    const refusal = decide({ actor, subject, named, othersRemaining });
    if (refusal) return refused(refusal);
    await change(tx);
    await tx.insert(administratorActions).values({ actor_user_id: actor.id, subject_user_id: subject.id, action, at: input.now });
    return { ok: true };
  });
}

/**
 * Remove a person's access: set `access_removed_at`, delete their sessions,
 * revoke their live refresh tokens (every family) and record the action, in
 * one transaction. Access tokens already issued expire at their own expiry
 * (one hour at most). The administrator flag is kept. Refused for one's own
 * access, and when it would leave no administrator with access.
 */
export function removeAccess(db: PrincipalsDb, input: AdministratorActionInput): Promise<AdministratorActionResult> {
  return administratorAction(
    db,
    input,
    "remove_access",
    ({ actor, subject, named, othersRemaining }) => {
      if (actor.id === subject.id) return "own_access";
      if (subject.access_removed_at !== null) return "no_change";
      if (administratorNow(subject, named) && othersRemaining === 0) return "last_administrator";
      return null;
    },
    async (tx) => {
      await tx.update(user).set({ accessRemovedAt: input.now, updatedAt: input.now }).where(eq(user.id, input.subject_user_id));
      await tx.delete(session).where(eq(session.userId, input.subject_user_id));
      await tx
        .update(oauthRefreshToken)
        .set({ revoked: input.now })
        .where(and(eq(oauthRefreshToken.userId, input.subject_user_id), isNull(oauthRefreshToken.revoked)));
    },
  );
}

/**
 * Restore a person's access and record it. The administrator flag was kept
 * at removal and is not touched here: a person who was an administrator is
 * one again. Sessions and refresh tokens are not brought back; consents were
 * never removed, so the person's clients re-authorise without a new consent.
 */
export function restoreAccess(db: PrincipalsDb, input: AdministratorActionInput): Promise<AdministratorActionResult> {
  return administratorAction(
    db,
    input,
    "restore_access",
    ({ subject }) => (subject.access_removed_at === null ? "no_change" : null),
    async (tx) => {
      await tx.update(user).set({ accessRemovedAt: null, updatedAt: input.now }).where(eq(user.id, input.subject_user_id));
    },
  );
}

/** Make a person with access an administrator (set the flag) and record it. */
export function grantAdministrator(db: PrincipalsDb, input: AdministratorActionInput): Promise<AdministratorActionResult> {
  return administratorAction(
    db,
    input,
    "grant_administrator",
    ({ subject, named }) => {
      if (subject.access_removed_at !== null) return "no_access";
      if (administratorNow(subject, named)) return "no_change";
      return null;
    },
    async (tx) => {
      await tx.update(user).set({ isAdministrator: true, updatedAt: input.now }).where(eq(user.id, input.subject_user_id));
    },
  );
}

/**
 * Withdraw a person's administrator role (clear the flag) and record it.
 * Refused for a person named in the configuration (they remain one while it
 * names them) and when it would leave no administrator with access.
 */
export function withdrawAdministrator(db: PrincipalsDb, input: AdministratorActionInput): Promise<AdministratorActionResult> {
  return administratorAction(
    db,
    input,
    "withdraw_administrator",
    ({ subject, named, othersRemaining }) => {
      if (isNamed(subject.email, named)) return "named_in_configuration";
      if (!subject.is_administrator) return "no_change";
      if (administratorNow(subject, named) && othersRemaining === 0) return "last_administrator";
      return null;
    },
    async (tx) => {
      await tx.update(user).set({ isAdministrator: false, updatedAt: input.now }).where(eq(user.id, input.subject_user_id));
    },
  );
}
