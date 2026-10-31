// tests/lib/mail-sink.ts against a fake object store (no AWS): the newest
// message for an address from a stage's sink, the ULID lower bound that keeps
// the listing to objects written after `since`, the magic-link extraction, the
// local-directory client and the environment resolution.
// m1-hosted-connector task 6.2 (design D6: `tmp/<stage>/mail/<ulid>.json`).
// Run: pnpm --filter @a2h/tests test
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { SinkRecord } from "@a2h/email/sink";
import {
  localSinkClient,
  magicLinkOf,
  messagesTo,
  newestMessageTo,
  sinkClientFromEnv,
  sinkPrefix,
  type SinkObjectClient,
  ulidLowerBound,
  waitForMagicLink,
} from "./mail-sink.ts";

const STAGE = "pr-51";
const PREFIX = "tmp/pr-51/mail/";
const T0 = new Date("2026-10-31T10:00:00.000Z");

function record(to: string, sentAt: Date, text = "hello"): SinkRecord {
  return { to, subject: "[test stage pr-51] Your A2H sign-in link", text, html: `<p>${text}</p>`, sent_at: sentAt.toISOString(), id: ulid(sentAt.getTime()) };
}

/** A fake store: objects by key (mutable, so a test can add a message while polling), and a log of every list and get. */
function fakeStore(records: SinkRecord[], extraKeys: string[] = []): { client: SinkObjectClient; calls: string[]; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  for (const r of records) objects.set(`${PREFIX}${r.id}.json`, JSON.stringify(r));
  for (const k of extraKeys) objects.set(k, "{}");
  const calls: string[] = [];
  const client: SinkObjectClient = {
    list(prefix, startAfter) {
      calls.push(`list ${prefix} after=${startAfter ?? "-"}`);
      return Promise.resolve(
        [...objects.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort(),
      );
    },
    get(key) {
      calls.push(`get ${key}`);
      const body = objects.get(key);
      if (body === undefined) return Promise.reject(new Error(`no such key ${key}`));
      return Promise.resolve(body);
    },
  };
  return { client, calls, objects };
}

describe("sinkPrefix and ulidLowerBound", () => {
  test("the sink of a stage is tmp/<stage>/mail/ (design D6, PR #58)", () => {
    assert.equal(sinkPrefix("pr-51"), "tmp/pr-51/mail/");
    assert.equal(sinkPrefix("dev"), "tmp/dev/mail/");
    assert.throws(() => sinkPrefix("prod"), /prod has no mail sink/);
    assert.throws(() => sinkPrefix("../x"), /not a stage/);
  });

  test("the lower bound sorts below every ULID minted at or after the instant, and above every earlier one", () => {
    const bound = ulidLowerBound(T0);
    assert.equal(bound.length, 26);
    for (let i = 0; i < 50; i++) {
      assert.ok(bound <= ulid(T0.getTime()), "a ULID of the same millisecond sorts at or after the bound");
      assert.ok(bound <= ulid(T0.getTime() + 1), "a later ULID sorts after the bound");
      assert.ok(bound > ulid(T0.getTime() - 1), "an earlier ULID sorts before the bound");
    }
  });
});

describe("messagesTo and newestMessageTo", () => {
  const a = "qa-principal-a@a2h-protocol.org";
  const b = "qa-principal-b@a2h-protocol.org";
  const older = record(a, new Date(T0.getTime() - 60_000), "old link https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=old");
  const first = record(a, new Date(T0.getTime() + 1_000), "first https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=one&callbackURL=%2F");
  const other = record(b, new Date(T0.getTime() + 2_000), "other https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=b");
  const second = record(a.toUpperCase(), new Date(T0.getTime() + 3_000), "second https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=two.");

  test("lists only the stage's prefix after the bound for `since`, fetches only what it lists, and returns the address's messages oldest first", async () => {
    const { client, calls } = fakeStore([older, first, other, second], ["tmp/pr-52/mail/01J0000000000000000000000A.json", "tmp/pr-51/other/x.json"]);
    const list = await messagesTo(client, STAGE, a, T0);
    assert.deepEqual(list.map((m) => m.id), [first.id, second.id], "the two messages to the address since T0, in time order (case-insensitive address)");
    assert.equal(calls[0], `list ${PREFIX} after=${PREFIX}${ulidLowerBound(new Date(T0.getTime() - 2_000))}`, "a full key as S3 StartAfter takes it, two seconds of skew allowed");
    assert.ok(!calls.includes(`get ${PREFIX}${older.id}.json`), "a message from before `since` is never fetched");
    assert.ok(!calls.some((c) => c.includes("pr-52") || c.includes("/other/")), "nothing outside the stage's mail prefix is touched");
  });

  test("the newest message, or undefined when none since", async () => {
    const { client } = fakeStore([older, first, other, second]);
    assert.equal((await newestMessageTo(client, STAGE, a, T0))?.id, second.id);
    assert.equal(await newestMessageTo(client, STAGE, "nobody@a2h-protocol.org", T0), undefined);
    assert.equal(await newestMessageTo(client, STAGE, a, new Date(T0.getTime() + 10_000)), undefined, "nothing after a later `since`");
  });

  test("magicLinkOf takes the verify link out of the text, without trailing punctuation", () => {
    assert.equal(magicLinkOf(second), "https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=two");
    assert.equal(magicLinkOf(first), "https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=one&callbackURL=%2F");
    assert.equal(magicLinkOf({ ...first, text: "no link here" }), undefined);
  });

  test("waitForMagicLink polls until the link arrives and fails, naming no address, when it does not", async () => {
    const store = fakeStore([]);
    const late = setTimeout(() => {
      const r = record(a, new Date(), "late https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=late");
      store.objects.set(`${PREFIX}${r.id}.json`, JSON.stringify(r));
    }, 120);
    try {
      const link = await waitForMagicLink(store.client, STAGE, a, new Date(Date.now() - 1_000), { timeoutMs: 3_000, everyMs: 40 });
      assert.equal(link, "https://pr-51.dev.a2h-protocol.org/api/auth/magic-link/verify?token=late");
    } finally {
      clearTimeout(late);
    }
    await assert.rejects(
      waitForMagicLink(fakeStore([]).client, STAGE, "secret-person@a2h-protocol.org", new Date(), { timeoutMs: 100, everyMs: 20 }),
      (e: Error) => !e.message.includes("secret-person") && /no magic link/.test(e.message),
    );
  });
});

describe("clients", () => {
  test("localSinkClient reads a LOCAL_MAIL_DIR layout (the same keys as S3), ignores non-JSON files and missing directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a2h-sink-"));
    try {
      const a = "qa-principal-a@a2h-protocol.org";
      const r1 = record(a, new Date(T0.getTime() + 1_000), "one https://localhost:3210/api/auth/magic-link/verify?token=1");
      const r2 = record(a, new Date(T0.getTime() + 2_000), "two https://localhost:3210/api/auth/magic-link/verify?token=2");
      mkdirSync(join(dir, PREFIX), { recursive: true });
      writeFileSync(join(dir, PREFIX, `${r1.id}.json`), JSON.stringify(r1));
      writeFileSync(join(dir, PREFIX, `${r2.id}.json`), JSON.stringify(r2));
      writeFileSync(join(dir, PREFIX, "README.txt"), "not a message");
      const client = localSinkClient(dir);
      assert.equal((await newestMessageTo(client, STAGE, a, T0))?.id, r2.id);
      assert.deepEqual(await messagesTo(client, "pr-7", a, T0), [], "another stage's directory does not exist: no messages, no error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sinkClientFromEnv: A2H_MAIL_SINK_DIR, else A2H_MAIL_SINK_BUCKET, else an error that says how to set them", () => {
    assert.equal(sinkClientFromEnv({ A2H_MAIL_SINK_DIR: "/tmp/x" }).source, "dir /tmp/x");
    assert.equal(sinkClientFromEnv({ A2H_MAIL_SINK_BUCKET: "a2h-dev-uploads" }).source, "s3://a2h-dev-uploads");
    assert.throws(() => sinkClientFromEnv({}), /A2H_MAIL_SINK_DIR.*A2H_MAIL_SINK_BUCKET/);
  });
});
