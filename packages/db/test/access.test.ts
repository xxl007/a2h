// m2-org-sign-in task 3.3 (design D7) against PostgreSQL 17 in Docker: the
// queries of src/queries/access.ts, each through node-postgres (mcp, worker)
// and through the Data API stand-in (apps/web's driver, test/lib/data-api.ts).
// Specs: platform/administration "Administrators remove and restore access",
// "Administrators name other administrators", "Administrator actions are
// recorded", "Administrators see who has access".
// Addresses here are synthetic (`@a2h.test`).
// `timestamp` columns (Better Auth's) are read by node-postgres in the process's zone: pin it.
process.env["TZ"] = "UTC";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleDataApi } from "drizzle-orm/aws-data-api/pg";
import {
  accessState,
  grantAdministrator,
  hasAccess,
  IDP_PROVIDER_ID,
  isAdministrator,
  listAdministratorActions,
  listPeople,
  removeAccess,
  restoreAccess,
  withdrawAdministrator,
  type A2hDb,
  type AdministratorActionInput,
} from "../src/index.ts";
import { dataApiStandIn, type DataApiStandIn } from "./lib/data-api.ts";
import { migrate, skipWithoutDocker, startPostgres, type PgContainer } from "./lib/postgres.ts";

const skip = skipWithoutDocker();
const NOW = new Date("2026-11-12T09:00:00.000Z");
const LATER = new Date("2026-11-12T10:30:00.000Z");
/** The install's configuration (`ADMINISTRATOR_EMAILS`), passed in by the caller: never read here. */
const CONFIGURED = ["Root@A2H.test "];
const NONE: readonly string[] = [];

let pgc: PgContainer;
let admin: pg.Client;

interface Driver {
  name: string;
  schema: string;
  /** Two databases on separate connections: two instances of the web app. */
  open: (schema: string) => { a: A2hDb; b: A2hDb; statements: () => { sql: string }[]; close: () => Promise<void> };
}

const drivers: Driver[] = [
  {
    name: "node-postgres",
    schema: "pr_access_pg",
    open: (schema) => {
      const opts = { connectionString: pgc.url, options: `-c search_path=${schema} -c timezone=UTC`, max: 6 };
      const [p1, p2] = [new pg.Pool(opts), new pg.Pool(opts)];
      return { a: drizzlePg(p1), b: drizzlePg(p2), statements: () => [], close: async () => void (await Promise.all([p1.end(), p2.end()])) };
    },
  },
  {
    name: "Data API stand-in",
    schema: "pr_access_da",
    open: (schema) => {
      const arns = { database: "a2h", resourceArn: "arn:aws:rds:eu-west-3:123456789012:cluster:test", secretArn: "arn:aws:secretsmanager:eu-west-3:123456789012:secret:test" };
      const apis: DataApiStandIn[] = [dataApiStandIn(pgc.url, schema), dataApiStandIn(pgc.url, schema)];
      const [a, b] = apis.map((api) => drizzleDataApi(api.client as never, arns) as unknown as A2hDb);
      return { a: a!, b: b!, statements: () => apis.flatMap((api) => api.statements), close: async () => void (await Promise.all(apis.map((api) => api.close()))) };
    },
  },
];

describe("access and administrator queries (Postgres 17)", { skip }, () => {
  before(async () => {
    pgc = await startPostgres();
    admin = new pg.Client({ connectionString: pgc.url });
    await admin.connect();
    for (const d of drivers) await migrate(admin, d.schema);
  });
  after(async () => {
    await admin?.end().catch(() => undefined);
    pgc?.stop();
  });

  for (const driver of drivers) {
    describe(driver.name, () => {
      const S = driver.schema;
      let db: A2hDb;
      let db2: A2hDb;
      let handle: ReturnType<Driver["open"]>;

      const q = async <R extends pg.QueryResultRow>(text: string, params: unknown[] = []) => (await admin.query<R>(text, params)).rows;

      /** An account as Better Auth writes it; optionally with a provider account, a session, a live refresh token and a consent. */
      async function person(id: string, o: { name?: string; email?: string; flagged?: boolean; removed?: boolean; provider?: boolean; connected?: boolean } = {}): Promise<void> {
        await q(`INSERT INTO ${S}."user" (id, name, email, email_verified, is_administrator, access_removed_at) VALUES ($1, $2, $3, true, $4, $5)`, [
          id,
          o.name ?? id,
          o.email ?? `${id}@a2h.test`,
          o.flagged ?? false,
          o.removed ? "2026-11-01T00:00:00Z" : null,
        ]);
        if (o.provider) await q(`INSERT INTO ${S}.account (id, account_id, provider_id, user_id, updated_at) VALUES ($1, $2, $3, $4, now())`, [`acc_${id}`, `sub-${id}`, IDP_PROVIDER_ID, id]);
        if (o.connected) {
          for (const n of [1, 2]) await q(`INSERT INTO ${S}.session (id, expires_at, token, updated_at, user_id) VALUES ($1, now() + interval '12 hours', $2, now(), $3)`, [`s${n}_${id}`, `tok${n}_${id}`, id]);
          await q(`INSERT INTO ${S}.oauth_client (id, client_id, redirect_uris) VALUES ($1, $2, '{"http://127.0.0.1/cb"}') ON CONFLICT DO NOTHING`, ["c1", "client-1"]);
          // Two families: a rotated-and-replaced token and its live successor, and a second live one; plus one already revoked.
          const ins = `INSERT INTO ${S}.oauth_refresh_token (id, token, client_id, session_id, user_id, expires_at, created_at, scopes, revoked) VALUES ($1, $2, 'client-1', $3, $4, now() + interval '30 days', now(), '{a2h,offline_access}', $5)`;
          await q(ins, [`r1_${id}`, `rt1_${id}`, `s1_${id}`, id, null]);
          await q(ins, [`r2_${id}`, `rt2_${id}`, `s2_${id}`, id, null]);
          await q(ins, [`r3_${id}`, `rt3_${id}`, null, id, "2026-10-01T00:00:00Z"]);
          await q(`INSERT INTO ${S}.oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) VALUES ($1, 'client-1', $2, '{a2h,offline_access}', now(), now())`, [`k_${id}`, id]);
        }
      }

      const act = (actor: string, subject: string, emails: readonly string[] = NONE, now = NOW): AdministratorActionInput => ({
        actor_user_id: actor,
        subject_user_id: subject,
        administrator_emails: emails,
        now,
      });

      /** Everything an action could change, to compare before and after a refusal. */
      async function snapshot(): Promise<unknown> {
        return {
          users: await q(`SELECT id, email, name, access_removed_at, is_administrator, last_idp_sign_in_at FROM ${S}."user" ORDER BY id`),
          sessions: await q(`SELECT id FROM ${S}.session ORDER BY id`),
          tokens: await q(`SELECT id, revoked FROM ${S}.oauth_refresh_token ORDER BY id`),
          consents: await q(`SELECT id FROM ${S}.oauth_consent ORDER BY id`),
          actions: await q(`SELECT id, actor_user_id, subject_user_id, action, at FROM ${S}.administrator_actions ORDER BY id`),
        };
      }
      const actions = () => q<{ actor_user_id: string; subject_user_id: string; action: string; at: Date }>(`SELECT actor_user_id, subject_user_id, action, at FROM ${S}.administrator_actions ORDER BY id`);
      const userRow = async (id: string) => (await q<{ access_removed_at: Date | null; is_administrator: boolean }>(`SELECT access_removed_at, is_administrator FROM ${S}."user" WHERE id = $1`, [id]))[0]!;

      before(() => {
        handle = driver.open(S);
        db = handle.a;
        db2 = handle.b;
      });
      after(async () => {
        await handle?.close();
      });
      /** Test-only reset: the append-only triggers are bypassed by the superuser's replication role. */
      async function reset(): Promise<void> {
        await admin.query(`SET session_replication_role = replica`);
        await admin.query(`TRUNCATE ${S}.administrator_actions, ${S}.oauth_consent, ${S}.oauth_refresh_token, ${S}.oauth_client, ${S}.session, ${S}.account, ${S}."user" RESTART IDENTITY CASCADE`);
        await admin.query(`SET session_replication_role = origin`);
      }
      beforeEach(reset);

      describe("the access predicate (design D7)", () => {
        test("an unknown account has no access state and no access", async () => {
          assert.equal(await accessState(db, "u_nobody"), null);
          assert.equal(hasAccess(null, true), false);
        });
        test("signed in through the provider: access unless removed; the allow-list is not asked", async () => {
          await person("u_idp", { provider: true });
          const state = await accessState(db, "u_idp");
          assert.deepEqual(state, { access_removed: false, has_provider_account: true });
          assert.equal(hasAccess(state, false), true);
          assert.equal(hasAccess(state, true), true);
        });
        test("without a provider account (magic link, development stages): access only while on the allow-list", async () => {
          await person("u_link");
          const state = await accessState(db, "u_link");
          assert.deepEqual(state, { access_removed: false, has_provider_account: false });
          assert.equal(hasAccess(state, true), true);
          assert.equal(hasAccess(state, false), false);
        });
        test("an account of another provider id is not a provider account", async () => {
          await person("u_other");
          await q(`INSERT INTO ${S}.account (id, account_id, provider_id, user_id, updated_at) VALUES ('acc_x', 'x', 'credential', 'u_other', now())`);
          assert.equal((await accessState(db, "u_other"))?.has_provider_account, false);
        });
        test("access removed: no access, whichever way the person signed in and whatever the allow-list says", async () => {
          await person("u_gone_idp", { provider: true, removed: true });
          await person("u_gone_link", { removed: true });
          for (const id of ["u_gone_idp", "u_gone_link"]) {
            const state = await accessState(db, id);
            assert.equal(state?.access_removed, true);
            assert.equal(hasAccess(state, true), false);
            assert.equal(hasAccess(state, false), false);
          }
        });
      });

      describe("who is an administrator (design D7)", () => {
        test("Scenario: Configured administrator signs in: named in the configuration passed in, whatever the letter case, without any stored flag", async () => {
          await person("u_root", { email: "root@a2h.test" });
          assert.equal(await isAdministrator(db, "u_root", CONFIGURED), true);
          assert.equal(await isAdministrator(db, "u_root", ["ROOT@a2h.TEST"]), true);
          assert.equal((await userRow("u_root")).is_administrator, false, "computed at each check, not stored");
        });
        test("flagged by an administrator's action: an administrator without being named", async () => {
          await person("u_flag", { flagged: true });
          assert.equal(await isAdministrator(db, "u_flag", NONE), true);
        });
        test("neither named nor flagged, or unknown: not an administrator", async () => {
          await person("u_plain");
          assert.equal(await isAdministrator(db, "u_plain", CONFIGURED), false);
          assert.equal(await isAdministrator(db, "u_plain", NONE), false);
          assert.equal(await isAdministrator(db, "u_nobody", CONFIGURED), false);
        });
        test("no longer named in the configuration: no longer an administrator at the next check", async () => {
          await person("u_root", { email: "root@a2h.test" });
          assert.equal(await isAdministrator(db, "u_root", ["someone.else@a2h.test"]), false);
        });
        test("access removed: not an administrator, whether flagged or named", async () => {
          await person("u_flag", { flagged: true, removed: true });
          await person("u_root", { email: "root@a2h.test", removed: true });
          assert.equal(await isAdministrator(db, "u_flag", NONE), false);
          assert.equal(await isAdministrator(db, "u_root", CONFIGURED), false);
        });
        test("an address is matched whole: no pattern, no partial match", async () => {
          await person("u_like", { email: "xroot@a2h.test" });
          assert.equal(await isAdministrator(db, "u_like", ["%root@a2h.test", "root@a2h.test", "_root@a2h.test"]), false);
        });
      });

      describe("the people list (spec \"Administrators see who has access\")", () => {
        test("Scenario: New person appears: listed with access and without the administrator role", async () => {
          await person("u_root", { email: "root@a2h.test", name: "Root" });
          await person("u_new", { name: "Ada New", email: "ada@a2h.test", provider: true });
          const people = await listPeople(db, CONFIGURED);
          assert.deepEqual(people.find((p) => p.user_id === "u_new"), {
            user_id: "u_new",
            name: "Ada New",
            email: "ada@a2h.test",
            has_access: true,
            is_administrator: false,
            administrator_flag: false,
            named_in_configuration: false,
          });
        });
        test("everyone who has signed in, sorted by name; access and role as the predicate decides", async () => {
          await person("u_root", { email: "root@a2h.test", name: "Zoe Root" });
          await person("u_flag", { name: "bob Flag", flagged: true });
          await person("u_gone", { name: "Carl Gone", flagged: true, removed: true });
          await person("u_plain", { name: "Ada Plain" });
          const people = await listPeople(db, CONFIGURED);
          assert.deepEqual(people.map((p) => p.name), ["Ada Plain", "bob Flag", "Carl Gone", "Zoe Root"]);
          const by = new Map(people.map((p) => [p.user_id, p]));
          assert.deepEqual([by.get("u_root")!.is_administrator, by.get("u_root")!.named_in_configuration, by.get("u_root")!.administrator_flag], [true, true, false]);
          assert.deepEqual([by.get("u_flag")!.is_administrator, by.get("u_flag")!.named_in_configuration, by.get("u_flag")!.administrator_flag], [true, false, true]);
          // Removed: not an administrator now, but the flag is kept for restoration.
          assert.deepEqual([by.get("u_gone")!.has_access, by.get("u_gone")!.is_administrator, by.get("u_gone")!.administrator_flag], [false, false, true]);
          assert.deepEqual([by.get("u_plain")!.has_access, by.get("u_plain")!.is_administrator], [true, false]);
        });
        test("a person carries no time of last activity or sign-in: exactly these fields", async () => {
          await person("u_plain", { provider: true });
          await q(`UPDATE ${S}."user" SET last_idp_sign_in_at = now()`);
          const [p] = await listPeople(db, NONE);
          assert.deepEqual(Object.keys(p!).sort(), ["administrator_flag", "email", "has_access", "is_administrator", "name", "named_in_configuration", "user_id"]);
        });
        test("selected columns: id, name, email, access_removed_at, is_administrator; never last_idp_sign_in_at", { skip: driver.name !== "Data API stand-in" && "statements are captured by the Data API stand-in" }, async () => {
          await person("u_plain");
          const from = handle.statements().length;
          await listPeople(db, CONFIGURED);
          const sent = handle.statements().slice(from);
          assert.equal(sent.length, 1);
          const m = /^select (.+) from "user"/i.exec(sent[0]!.sql);
          assert.ok(m, sent[0]!.sql);
          const columns = [...m[1]!.matchAll(/"([a-z_]+)"(?=\s*(,|$))/g)].map((c) => c[1]).sort();
          assert.deepEqual(columns, ["access_removed_at", "email", "id", "is_administrator", "name"]);
          assert.doesNotMatch(sent[0]!.sql, /last_idp_sign_in_at|\*/);
        });
        test("no statement of this module reads last_idp_sign_in_at", { skip: driver.name !== "Data API stand-in" && "statements are captured by the Data API stand-in" }, async () => {
          await person("u_admin", { flagged: true });
          await person("u_person", { connected: true });
          const from = handle.statements().length;
          await removeAccess(db, act("u_admin", "u_person"));
          await restoreAccess(db, act("u_admin", "u_person"));
          await grantAdministrator(db, act("u_admin", "u_person"));
          await withdrawAdministrator(db, act("u_admin", "u_person"));
          await listAdministratorActions(db);
          await isAdministrator(db, "u_admin", NONE);
          await accessState(db, "u_admin");
          const sent = handle.statements().slice(from);
          assert.ok(sent.length >= 10);
          for (const s of sent) assert.doesNotMatch(s.sql, /last_idp_sign_in_at/, s.sql);
        });
      });

      describe("removing and restoring access", () => {
        test("Scenario: Access removed: the column is set, every session deleted, every live refresh token revoked, the action recorded", async () => {
          await person("u_admin", { flagged: true, connected: true });
          await person("u_person", { provider: true, connected: true });
          assert.deepEqual(await removeAccess(db, act("u_admin", "u_person")), { ok: true });
          assert.equal((await userRow("u_person")).access_removed_at?.toISOString(), NOW.toISOString());
          assert.deepEqual(await q(`SELECT id FROM ${S}.session WHERE user_id = 'u_person'`), []);
          const tokens = await q<{ id: string; revoked: Date | null }>(`SELECT id, revoked FROM ${S}.oauth_refresh_token WHERE user_id = 'u_person' ORDER BY id`);
          assert.deepEqual(tokens.map((t) => [t.id, t.revoked?.toISOString()]), [
            ["r1_u_person", NOW.toISOString()],
            ["r2_u_person", NOW.toISOString()],
            ["r3_u_person", "2026-10-01T00:00:00.000Z"], // revoked earlier: its time is kept
          ]);
          // The gates of sign-in, consent and refresh ask this and get "no".
          assert.equal(hasAccess(await accessState(db, "u_person"), true), false);
          // The administrator's own sessions and tokens are untouched.
          assert.equal((await q(`SELECT id FROM ${S}.session WHERE user_id = 'u_admin'`)).length, 2);
          assert.equal((await q(`SELECT id FROM ${S}.oauth_refresh_token WHERE user_id = 'u_admin' AND revoked IS NULL`)).length, 2);
        });
        test("Scenario: Access removed: the person's record is kept (account, provider account, consents)", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person", { provider: true, connected: true });
          await removeAccess(db, act("u_admin", "u_person"));
          assert.equal((await q(`SELECT id FROM ${S}."user" WHERE id = 'u_person'`)).length, 1);
          assert.equal((await q(`SELECT id FROM ${S}.account WHERE user_id = 'u_person'`)).length, 1);
          assert.equal((await q(`SELECT id FROM ${S}.oauth_consent WHERE user_id = 'u_person'`)).length, 1);
        });
        test("one transaction: if the action row cannot be written, the access, the sessions and the tokens are as before", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person", { connected: true });
          const before = await snapshot();
          // The record refuses the insert: nothing of the removal may stay.
          await admin.query(`ALTER TABLE ${S}.administrator_actions ADD CONSTRAINT test_refuse CHECK (action <> 'remove_access') NOT VALID`);
          try {
            await assert.rejects(removeAccess(db, act("u_admin", "u_person")));
          } finally {
            await admin.query(`ALTER TABLE ${S}.administrator_actions DROP CONSTRAINT test_refuse`);
          }
          assert.deepEqual(await snapshot(), before);
        });
        test("runs inside a caller's transaction and is rolled back with it", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person", { connected: true });
          const before = await snapshot();
          await assert.rejects(
            db.transaction(async (tx) => {
              assert.deepEqual(await removeAccess(tx, act("u_admin", "u_person")), { ok: true });
              throw new Error("caller failed");
            }),
            /caller failed/,
          );
          assert.deepEqual(await snapshot(), before);
        });
        test("Scenario: Access restored: the column is cleared, the action recorded; consents were never touched, so they work again", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person", { provider: true, connected: true });
          await removeAccess(db, act("u_admin", "u_person"));
          assert.deepEqual(await restoreAccess(db, act("u_admin", "u_person", NONE, LATER)), { ok: true });
          assert.equal((await userRow("u_person")).access_removed_at, null);
          assert.equal(hasAccess(await accessState(db, "u_person"), false), true);
          assert.equal((await q(`SELECT id FROM ${S}.oauth_consent WHERE user_id = 'u_person'`)).length, 1);
          // Restoring does not bring back sessions or un-revoke tokens: the person signs in again.
          assert.equal((await q(`SELECT id FROM ${S}.session WHERE user_id = 'u_person'`)).length, 0);
          assert.equal((await q(`SELECT id FROM ${S}.oauth_refresh_token WHERE user_id = 'u_person' AND revoked IS NULL`)).length, 0);
          assert.deepEqual((await actions()).map((a) => a.action), ["remove_access", "restore_access"]);
        });
        test("Scenario: Access restored: restoring does not clear the administrator flag; the person is an administrator again", async () => {
          await person("u_admin", { flagged: true });
          await person("u_second", { flagged: true });
          await removeAccess(db, act("u_admin", "u_second"));
          assert.deepEqual(await userRow("u_second").then((r) => r.is_administrator), true, "removal keeps the flag");
          assert.equal(await isAdministrator(db, "u_second", NONE), false);
          await restoreAccess(db, act("u_admin", "u_second"));
          assert.equal((await userRow("u_second")).is_administrator, true);
          assert.equal(await isAdministrator(db, "u_second", NONE), true);
        });
        test("Scenario: Access of an administrator removed: a flagged one and one named in the configuration lose access and are not administrators meanwhile", async () => {
          await person("u_admin", { flagged: true });
          await person("u_flag", { flagged: true, connected: true });
          await person("u_root", { email: "root@a2h.test", connected: true });
          assert.deepEqual(await removeAccess(db, act("u_admin", "u_flag", CONFIGURED)), { ok: true });
          assert.deepEqual(await removeAccess(db, act("u_admin", "u_root", CONFIGURED)), { ok: true });
          for (const id of ["u_flag", "u_root"]) {
            assert.equal(await isAdministrator(db, id, CONFIGURED), false, id);
            assert.equal((await q(`SELECT id FROM ${S}.session WHERE user_id = $1`, [id])).length, 0);
          }
          assert.equal(await isAdministrator(db, "u_admin", CONFIGURED), true);
        });
        test("Scenario: Administrator removes their own access: refused, whether or not other administrators remain", async () => {
          await person("u_admin", { flagged: true, connected: true });
          await person("u_second", { flagged: true });
          const before = await snapshot();
          assert.deepEqual(await removeAccess(db, act("u_admin", "u_admin")), { ok: false, refusal: "own_access" });
          assert.deepEqual(await snapshot(), before);
        });
        test("removing access already removed, or restoring access not removed, changes and records nothing", async () => {
          await person("u_admin", { flagged: true });
          await person("u_gone", { removed: true });
          await person("u_here");
          const before = await snapshot();
          assert.deepEqual(await removeAccess(db, act("u_admin", "u_gone")), { ok: false, refusal: "no_change" });
          assert.deepEqual(await restoreAccess(db, act("u_admin", "u_here")), { ok: false, refusal: "no_change" });
          assert.deepEqual(await snapshot(), before);
        });
      });

      describe("granting and withdrawing the administrator role", () => {
        test("Scenario: Role granted: the person is an administrator at the next check; the action is recorded", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person");
          assert.equal(await isAdministrator(db, "u_person", NONE), false);
          assert.deepEqual(await grantAdministrator(db, act("u_admin", "u_person")), { ok: true });
          assert.equal(await isAdministrator(db2, "u_person", NONE), true);
          assert.deepEqual((await actions()).map((a) => [a.actor_user_id, a.subject_user_id, a.action]), [["u_admin", "u_person", "grant_administrator"]]);
        });
        test("Role granted only to a person with access; an administrator already is one", async () => {
          await person("u_admin", { flagged: true });
          await person("u_gone", { removed: true });
          await person("u_flag", { flagged: true });
          await person("u_root", { email: "root@a2h.test" });
          const before = await snapshot();
          assert.deepEqual(await grantAdministrator(db, act("u_admin", "u_gone", CONFIGURED)), { ok: false, refusal: "no_access" });
          assert.deepEqual(await grantAdministrator(db, act("u_admin", "u_flag", CONFIGURED)), { ok: false, refusal: "no_change" });
          assert.deepEqual(await grantAdministrator(db, act("u_admin", "u_root", CONFIGURED)), { ok: false, refusal: "no_change" });
          assert.deepEqual(await grantAdministrator(db, act("u_admin", "u_admin", CONFIGURED)), { ok: false, refusal: "no_change" });
          assert.deepEqual(await snapshot(), before);
        });
        test("the role is withdrawn from another administrator, and from oneself while another remains", async () => {
          await person("u_admin", { flagged: true });
          await person("u_second", { flagged: true });
          await person("u_third", { flagged: true });
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_second")), { ok: true });
          assert.equal(await isAdministrator(db, "u_second", NONE), false);
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_admin")), { ok: true });
          assert.equal(await isAdministrator(db, "u_admin", NONE), false);
          assert.equal(await isAdministrator(db, "u_third", NONE), true);
          assert.deepEqual((await actions()).map((a) => a.action), ["withdraw_administrator", "withdraw_administrator"]);
        });
        test("Scenario: Last administrator: withdrawing the role of the only administrator is refused", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person");
          const before = await snapshot();
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_admin")), { ok: false, refusal: "last_administrator" });
          assert.deepEqual(await snapshot(), before);
        });
        test("Scenario: Last administrator: only administrators who have signed in and have access count as remaining", async () => {
          await person("u_admin", { flagged: true });
          // Flagged but access removed; named in the configuration but access removed; named but never signed in (no account).
          await person("u_gone", { flagged: true, removed: true });
          await person("u_root", { email: "root@a2h.test", removed: true });
          const emails = [...CONFIGURED, "never.signed.in@a2h.test"];
          const before = await snapshot();
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_admin", emails)), { ok: false, refusal: "last_administrator" });
          assert.deepEqual(await snapshot(), before);
        });
        test("an administrator named in the configuration remains one: withdrawal is refused; a named one counts as remaining", async () => {
          await person("u_admin", { flagged: true });
          await person("u_root", { email: "root@a2h.test" });
          const before = await snapshot();
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_root", CONFIGURED)), { ok: false, refusal: "named_in_configuration" });
          assert.deepEqual(await snapshot(), before);
          // The flagged one can go: the named one remains.
          assert.deepEqual(await withdrawAdministrator(db, act("u_root", "u_admin", CONFIGURED)), { ok: true });
          assert.equal(await isAdministrator(db, "u_root", CONFIGURED), true);
        });
        test("withdrawing from a person who holds no role changes and records nothing", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person");
          const before = await snapshot();
          assert.deepEqual(await withdrawAdministrator(db, act("u_admin", "u_person")), { ok: false, refusal: "no_change" });
          assert.deepEqual(await snapshot(), before);
        });
      });

      describe("only an administrator acts (decided in the same transaction)", () => {
        test("Scenario: Refused action leaves no change: a person who is not an administrator, or has lost access, or is unknown, changes nothing by any action", async () => {
          await person("u_admin", { flagged: true });
          await person("u_plain", { connected: true });
          await person("u_was", { flagged: true, removed: true });
          await person("u_target", { connected: true, flagged: true });
          const before = await snapshot();
          for (const actor of ["u_plain", "u_was", "u_nobody"]) {
            for (const fn of [removeAccess, restoreAccess, grantAdministrator, withdrawAdministrator]) {
              assert.deepEqual(await fn(db, act(actor, "u_target")), { ok: false, refusal: "not_administrator" }, `${actor} ${fn.name}`);
            }
          }
          assert.deepEqual(await snapshot(), before);
        });
        test("an unknown subject is refused without a record", async () => {
          await person("u_admin", { flagged: true });
          const before = await snapshot();
          for (const fn of [removeAccess, restoreAccess, grantAdministrator, withdrawAdministrator]) {
            assert.deepEqual(await fn(db, act("u_admin", "u_nobody")), { ok: false, refusal: "unknown_person" }, fn.name);
          }
          assert.deepEqual(await snapshot(), before);
        });
      });

      describe("under a lock: concurrent actions", () => {
        test("Scenario: Last administrator: two administrators removing each other's access at once: exactly one goes through, an administrator remains", async () => {
          for (let round = 0; round < 8; round++) {
            const [x, y] = [`u_x${round}`, `u_y${round}`];
            await person(x, { flagged: true, connected: true });
            await person(y, { flagged: true, connected: true });
            const results = await Promise.all([removeAccess(db, act(x, y)), removeAccess(db2, act(y, x))]);
            assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], JSON.stringify(results));
            assert.deepEqual(results.find((r) => !r.ok), { ok: false, refusal: "not_administrator" });
            const left = (await listPeople(db, NONE)).filter((p) => p.is_administrator);
            assert.equal(left.length, 1, `round ${round}`);
            const winner = left[0]!.user_id;
            const loser = winner === x ? y : x;
            assert.deepEqual((await actions()).map((a) => [a.actor_user_id, a.subject_user_id, a.action]), [[winner, loser, "remove_access"]]);
            assert.equal((await q(`SELECT id FROM ${S}.session WHERE user_id = $1`, [winner])).length, 2, "the remaining administrator keeps their sessions");
            assert.equal((await q(`SELECT id FROM ${S}.session WHERE user_id = $1`, [loser])).length, 0);
            await reset();
          }
        });
        test("Scenario: Last administrator: two administrators withdrawing each other's role at once, and each their own: one administrator always remains", async () => {
          for (let round = 0; round < 8; round++) {
            const [x, y] = [`u_x${round}`, `u_y${round}`];
            await person(x, { flagged: true });
            await person(y, { flagged: true });
            const own = round % 2 === 1;
            const results = await Promise.all([withdrawAdministrator(db, act(x, own ? x : y)), withdrawAdministrator(db2, act(y, own ? y : x))]);
            assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], JSON.stringify(results));
            assert.equal(results.find((r) => !r.ok && r.refusal === (own ? "last_administrator" : "not_administrator")) !== undefined, true, JSON.stringify(results));
            assert.equal((await listPeople(db, NONE)).filter((p) => p.is_administrator).length, 1, `round ${round}`);
            assert.equal((await actions()).length, 1);
            await reset();
          }
        });
      });

      describe("the record (spec \"Administrator actions are recorded\")", () => {
        test("Scenario: Action recorded: the record shows the administrator, the person, the action and the time", async () => {
          await person("u_admin", { name: "Ada Admin", email: "ada@a2h.test", flagged: true });
          await person("u_person", { name: "Per Son", email: "per@a2h.test" });
          await removeAccess(db, act("u_admin", "u_person", NONE, NOW));
          const record = await listAdministratorActions(db2);
          assert.equal(record.length, 1);
          assert.deepEqual(record[0], {
            id: record[0]!.id,
            action: "remove_access",
            at: NOW,
            actor: { user_id: "u_admin", name: "Ada Admin", email: "ada@a2h.test" },
            subject: { user_id: "u_person", name: "Per Son", email: "per@a2h.test" },
          });
          assert.equal(typeof record[0]?.id, "number");
        });
        test("Scenario: Action recorded: every action is there, newest first, with each person's current name and address", async () => {
          await person("u_admin", { name: "Ada Admin", email: "ada@a2h.test", flagged: true });
          await person("u_person", { name: "Per Son", email: "per@a2h.test" });
          const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
          await removeAccess(db, act("u_admin", "u_person", NONE, at(0)));
          await restoreAccess(db, act("u_admin", "u_person", NONE, at(1)));
          await grantAdministrator(db, act("u_admin", "u_person", NONE, at(2)));
          await withdrawAdministrator(db, act("u_person", "u_admin", NONE, at(3)));
          // The provider reported a new name and address at a later sign-in.
          await q(`UPDATE ${S}."user" SET name = 'Per Renamed', email = 'per.renamed@a2h.test' WHERE id = 'u_person'`);
          const record = await listAdministratorActions(db);
          assert.deepEqual(record.map((e) => [e.action, e.actor.user_id, e.subject.user_id, e.at.toISOString()]), [
            ["withdraw_administrator", "u_person", "u_admin", at(3).toISOString()],
            ["grant_administrator", "u_admin", "u_person", at(2).toISOString()],
            ["restore_access", "u_admin", "u_person", at(1).toISOString()],
            ["remove_access", "u_admin", "u_person", at(0).toISOString()],
          ]);
          assert.deepEqual(record[0]!.actor, { user_id: "u_person", name: "Per Renamed", email: "per.renamed@a2h.test" });
          assert.deepEqual(record[3]!.subject, { user_id: "u_person", name: "Per Renamed", email: "per.renamed@a2h.test" });
        });
        test("Scenario: Action recorded: an entry cannot be changed or deleted through the application's connection", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person");
          await removeAccess(db, act("u_admin", "u_person"));
          const { administratorActions, sql } = await import("../src/index.ts");
          await assert.rejects(db.update(administratorActions).set({ action: "restore_access" }), (e: unknown) => /append-only/.test(String((e as Error).cause ?? e)));
          await assert.rejects(db.delete(administratorActions), (e: unknown) => /append-only/.test(String((e as Error).cause ?? e)));
          await assert.rejects(db.execute(sql`TRUNCATE administrator_actions`), (e: unknown) => /append-only/.test(String((e as Error).cause ?? e)));
          assert.equal((await listAdministratorActions(db)).length, 1);
        });
        test("Scenario: Refused action leaves no change: own access and last administrator write no entry", async () => {
          await person("u_admin", { flagged: true });
          await person("u_person");
          assert.equal((await removeAccess(db, act("u_admin", "u_admin"))).ok, false);
          assert.equal((await withdrawAdministrator(db, act("u_admin", "u_admin"))).ok, false);
          assert.deepEqual(await listAdministratorActions(db), []);
          assert.deepEqual(await userRow("u_admin"), { access_removed_at: null, is_administrator: true });
        });
      });
    });
  }
});
