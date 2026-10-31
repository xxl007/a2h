// Task 6.1, design D6: the sink writes one JSON object per message under
// `<prefix>mail/<id>.json`, the content round-trips, ids sort by time, and
// nothing is logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { S3SinkMailer, type ObjectPutClient, type PutObjectArgs, type SinkRecord } from "../src/sink.ts";

function memory() {
  const puts: PutObjectArgs[] = [];
  const client: ObjectPutClient = {
    putObject(args) {
      puts.push(args);
      return Promise.resolve();
    },
  };
  return { client, puts };
}

const message = { to: "owner@example.com", subject: "[test stage dev] Your A2H sign-in link", text: "t https://x/y", html: "<a href=\"https://x/y\">x</a>" };

test("one object per message under <prefix>mail/<id>.json, content round-trips", async () => {
  const { client, puts } = memory();
  const now = new Date("2026-10-30T09:10:00.000Z");
  const sink = new S3SinkMailer({ client, bucket: "a2h-dev-uploads", prefix: "dev/", now: () => now });
  const a = await sink.send(message);
  const b = await sink.send({ ...message, to: "qa@example.com" });
  assert.equal(puts.length, 2);
  assert.notEqual(a.id, b.id);
  assert.equal(puts[0]?.bucket, "a2h-dev-uploads");
  assert.equal(puts[0]?.key, `dev/mail/${a.id}.json`);
  assert.equal(puts[1]?.key, `dev/mail/${b.id}.json`);
  assert.equal(puts[0]?.contentType, "application/json");
  assert.deepEqual(JSON.parse(puts[0]?.body ?? ""), { ...message, sent_at: now.toISOString(), id: a.id });
  assert.equal((JSON.parse(puts[1]?.body ?? "") as SinkRecord).to, "qa@example.com");
});

test("ids are ULIDs that sort by send time", async () => {
  const { client } = memory();
  let t = Date.parse("2026-10-30T09:10:00.000Z");
  const sink = new S3SinkMailer({ client, bucket: "b", prefix: "pr-12/", now: () => new Date((t += 1000)) });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await sink.send(message)).id);
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([...ids].sort(), ids);
});

test("the prefix is joined with exactly one slash", async () => {
  for (const prefix of ["pr-12", "pr-12/", "pr-12//"]) {
    const { client, puts } = memory();
    const { id } = await new S3SinkMailer({ client, bucket: "b", prefix }).send(message);
    assert.equal(puts[0]?.key, `pr-12/mail/${id}.json`);
  }
});

test("an empty prefix is refused (every stage writes under its own prefix)", () => {
  const { client } = memory();
  assert.throws(() => new S3SinkMailer({ client, bucket: "b", prefix: "" }), TypeError);
  assert.throws(() => new S3SinkMailer({ client, bucket: "b", prefix: "/" }), TypeError);
});

test("nothing is logged", async (t) => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => t.mock.method(console, m));
  const write = t.mock.method(process.stdout, "write");
  const { client } = memory();
  await new S3SinkMailer({ client, bucket: "b", prefix: "dev/" }).send(message);
  for (const s of spies) assert.equal(s.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 0);
});
