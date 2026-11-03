// m2-approval-page task 5.4: the e2e flows on a preview need an awaiting
// request for the QA principal before `request_human` returns the link
// (group 3). POST /test-fixtures/approval records one, as request_human
// would (validated, awaiting approval, nothing held or delivered), for the
// signed-in principal only and to a simulated participant only. Refused on
// prod; refused signed out.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { handleApprovalFixture, type FixtureDeps } from "../src/approval/fixture";
import { createLogger } from "../src/log";
import { POLICY, startApprovalDb, stored, type ApprovalDb } from "./lib/approval-db";

const adminUrl = inject("pgAdminUrl");

function post(body: unknown): Request {
  return new Request("https://pr-12.dev.a2h-protocol.org/test-fixtures/approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe.skipIf(!adminUrl)("POST /test-fixtures/approval", () => {
  let d: ApprovalDb;
  let deps: (over?: Partial<FixtureDeps>) => FixtureDeps;
  beforeAll(async () => {
    d = await startApprovalDb(adminUrl, "web_fixture");
    deps = (over = {}) => ({
      stage: "pr-12",
      db: d.db,
      feeRate: 0.2,
      defaultPolicy: POLICY,
      baseURL: "https://pr-12.dev.a2h-protocol.org",
      principalId: () => Promise.resolve("user-fixture-qa"),
      logger: createLogger({ write: () => undefined }),
      ...over,
    });
  });
  afterAll(async () => {
    await d?.close();
  });

  test("refused on prod: 404, nothing recorded", async () => {
    const before = await d.sql<{ n: string }>("SELECT count(*) AS n FROM requests");
    const res = await handleApprovalFixture(deps({ stage: "prod" }), post({}));
    expect(res.status).toBe(404);
    expect(await d.sql<{ n: string }>("SELECT count(*) AS n FROM requests")).toEqual(before);
  });

  test("refused signed out: 401", async () => {
    const res = await handleApprovalFixture(deps({ principalId: () => Promise.resolve(undefined) }), post({}));
    expect(res.status).toBe(401);
  });

  test("a paid request for the session's principal, awaiting approval, to a simulated participant, with its link", async () => {
    const res = await handleApprovalFixture(deps(), post({}));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { request_id: string; url: string; question: string };
    expect(body.request_id).toMatch(/^A2H-[0-9a-f]{4}$/);
    expect(body.url).toMatch(new RegExp(`^https://pr-12\\.dev\\.a2h-protocol\\.org/approve/${body.request_id}\\?t=[A-Za-z0-9_-]{43}$`));
    expect(await stored(d, body.request_id)).toMatchObject({ status: "awaiting_approval", question: body.question });
    const [r] = await d.sql<{ principal_id: string; simulated: boolean; bid_minor: number }>(
      "SELECT r.principal_id, p.simulated, r.bid_minor FROM requests r JOIN participants p ON p.id = r.participant_id WHERE r.id = $1",
      [body.request_id],
    );
    expect(r).toEqual({ principal_id: "user-fixture-qa", simulated: true, bid_minor: 3500 });
  });

  test("a poll with options and a scale", async () => {
    const res = await handleApprovalFixture(deps(), post({ variant: "poll" }));
    expect(res.status).toBe(201);
    const { request_id } = (await res.json()) as { request_id: string };
    const [r] = await d.sql<{ format: string; options: unknown; scale: unknown }>("SELECT format, options, scale FROM requests WHERE id = $1", [request_id]);
    expect(r!.format).toBe("poll");
    expect(Array.isArray(r!.options)).toBe(true);
    expect(r!.scale).toEqual({ min: 1, max: 5 });
  });

  test("a link already past its expiry", async () => {
    const res = await handleApprovalFixture(deps(), post({ variant: "expired" }));
    const { request_id } = (await res.json()) as { request_id: string };
    const [r] = await d.sql<{ approval_expires_at: Date }>("SELECT approval_expires_at FROM requests WHERE id = $1", [request_id]);
    expect(r!.approval_expires_at.getTime()).toBeLessThan(Date.now());
  });

  test("an unknown variant: 400", async () => {
    expect((await handleApprovalFixture(deps(), post({ variant: "real-person" }))).status).toBe(400);
  });
});
