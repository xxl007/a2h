// apps/web/infra adapters: the allow-list source (design D7) and the mailer
// (design D6, spec "Preview sign-in": non-prod stages write to the sink and
// send nothing).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParameterNotFound } from "@aws-sdk/client-ssm";
import { afterAll, describe, expect, test } from "vitest";
import { allowlistLoader } from "../infra/allowlist";
import { createMailer } from "../infra/mail";

describe("allowlistLoader", () => {
  test("no parameter configured: the PRINCIPAL_ALLOWLIST fallback", async () => {
    expect(await allowlistLoader({ parameter: undefined, fallback: "a@example.com" })()).toBe("a@example.com");
  });

  test("reads the SecureString parameter with decryption", async () => {
    const calls: unknown[] = [];
    const client = {
      send: (cmd: { input: unknown }) => {
        calls.push(cmd.input);
        return Promise.resolve({ Parameter: { Value: "b@example.com" } });
      },
    };
    const load = allowlistLoader({ parameter: "/a2h/shared/principal-allowlist", fallback: "a@example.com" }, client);
    expect(await load()).toBe("b@example.com");
    expect(calls).toEqual([{ Name: "/a2h/shared/principal-allowlist", WithDecryption: true }]);
  });

  test("parameter not created yet (task 8.2): the fallback; any other error is thrown", async () => {
    const missing = { send: () => Promise.reject(new ParameterNotFound({ message: "x", $metadata: {} })) };
    expect(await allowlistLoader({ parameter: "/a2h/shared/principal-allowlist", fallback: "a@example.com" }, missing as never)()).toBe("a@example.com");
    const denied = { send: () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })) };
    await expect(allowlistLoader({ parameter: "/p", fallback: "" }, denied as never)()).rejects.toThrow("denied");
  });
});

describe("createMailer", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("a preview writes one object under tmp/pr-<n>/mail/ and sends nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a2h-mail-"));
    dirs.push(dir);
    const mailer = createMailer({ stage: "pr-12", emailFrom: "", uploadsBucket: "b", mailSinkPrefix: "tmp/pr-12/", localDir: dir });
    const { id } = await mailer.send({ to: "a@example.com", subject: "s", text: "t", html: "<p>h</p>" });
    const files = await readdir(join(dir, "tmp", "pr-12", "mail"));
    expect(files).toEqual([`${id}.json`]);
    const record = JSON.parse(await readFile(join(dir, "tmp", "pr-12", "mail", files[0]!), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ to: "a@example.com", subject: "s", id });
  });

  test("prod refuses a local directory", () => {
    expect(() => createMailer({ stage: "prod", emailFrom: "x@a2h-protocol.org", uploadsBucket: "", mailSinkPrefix: "tmp/prod/", localDir: "/tmp/x" })).toThrow(/refused on prod/);
  });
});
