// The sign-in retry of tests/lib/obtain-token.ts (m1-hosted-connector task 8.3,
// design D7): the web app re-reads the allow-list within five minutes, and an
// address not yet on its copy is answered neutrally with no sink message. One
// attempt asks for a link and waits for it; without a link the script asks
// again, from the start of the authorization, until about 5.5 minutes have
// passed since it began. Nothing it prints names an address.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { signInUntilLink, SIGN_IN_RETRY_MS, LINK_ATTEMPT_MS } from "./obtain-token.ts";

const ADDRESS = "qa-principal-a@a2h-protocol.org";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("signInUntilLink", () => {
  test("a link on the first attempt is returned at once, one attempt logged", async () => {
    const c = clock();
    const lines: string[] = [];
    const link = await signInUntilLink(() => Promise.resolve("https://pr-12.dev.example/api/auth/magic-link/verify?token=t1"), { now: c.now, log: (l) => lines.push(l) });
    assert.equal(link, "https://pr-12.dev.example/api/auth/magic-link/verify?token=t1");
    assert.equal(lines.length, 0, "nothing to say when the first attempt succeeds");
  });

  test("no link within an attempt: asks again until the link arrives, says so without naming the address", async () => {
    const c = clock();
    const lines: string[] = [];
    let attempts = 0;
    const link = await signInUntilLink(
      (attemptMs) => {
        attempts += 1;
        c.advance(attemptMs);
        return Promise.resolve(attempts < 3 ? undefined : "https://pr-12.dev.example/verify?token=t3");
      },
      { now: c.now, log: (l) => lines.push(l), address: ADDRESS },
    );
    assert.equal(link, "https://pr-12.dev.example/verify?token=t3");
    assert.equal(attempts, 3);
    assert.equal(lines.length, 2, "one line per failed attempt");
    for (const l of lines) {
      assert.match(l, /no magic link within/, l);
      assert.match(l, /allow-list/, "the likely cause is named");
      assert.ok(!l.includes(ADDRESS) && !l.includes("qa-principal"), `an address in a log line: ${l}`);
    }
  });

  test("gives up after the retry window (about 5.5 minutes), naming the attempts and the window, never the address", async () => {
    const c = clock();
    let attempts = 0;
    await assert.rejects(
      signInUntilLink(
        (attemptMs) => {
          attempts += 1;
          c.advance(attemptMs);
          return Promise.resolve(undefined);
        },
        { now: c.now, log: () => undefined, address: ADDRESS },
      ),
      (e: Error) => {
        assert.match(e.message, new RegExp(`${attempts} sign-in attempt`));
        assert.match(e.message, /allow-list/);
        assert.ok(!e.message.includes(ADDRESS) && !e.message.includes("qa-principal"), e.message);
        return true;
      },
    );
    assert.equal(attempts, Math.ceil(SIGN_IN_RETRY_MS / LINK_ATTEMPT_MS), `one attempt per ${LINK_ATTEMPT_MS} ms over ${SIGN_IN_RETRY_MS} ms`);
    assert.ok(SIGN_IN_RETRY_MS >= 5 * 60_000 && SIGN_IN_RETRY_MS <= 6 * 60_000, "the window covers the allow-list's five-minute refresh (D7) with a margin");
  });

  test("the last attempt is shortened to the end of the window, not skipped", async () => {
    const c = clock();
    const given: number[] = [];
    await assert.rejects(
      signInUntilLink(
        (attemptMs) => {
          given.push(attemptMs);
          c.advance(attemptMs);
          return Promise.resolve(undefined);
        },
        { now: c.now, log: () => undefined, retryForMs: LINK_ATTEMPT_MS * 2.5 },
      ),
    );
    assert.deepEqual(given, [LINK_ATTEMPT_MS, LINK_ATTEMPT_MS, LINK_ATTEMPT_MS / 2]);
  });
});
