// The sign-in retry of tests/lib/obtain-token.ts (m1-hosted-connector task 8.3,
// design D7): the web app re-reads the allow-list within five minutes, and an
// address not yet on its copy is answered neutrally with no sink message. One
// attempt asks for a link and waits for it; without a link the script asks
// again, from the start of the authorization, until about 5.5 minutes have
// passed since it began. Nothing it prints names an address.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describePage, disconnectAll, saveSession, signInUntilLink, startCallbackListener, SIGN_IN_RETRY_MS, LINK_ATTEMPT_MS } from "./obtain-token.ts";

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

describe("startCallbackListener", () => {
  test("answers the client's loopback redirect URI for real (a 302 from the authorization server lands here) and hands the URL over", async () => {
    // Port 0: an ephemeral port, read back from the listener, so a parallel workspace or a leftover
    // server on the production port (LOOPBACK_REDIRECT) cannot fail this test with EADDRINUSE.
    const listener = await startCallbackListener("http://127.0.0.1:0/callback");
    try {
      const base = listener.url;
      assert.equal(base.hostname, "127.0.0.1");
      assert.equal(base.pathname, "/callback");
      assert.notEqual(base.port, "0", "the bound port is read back");
      assert.ok(Number(base.port) > 0);
      const at = (path: string) => new URL(path, base).href;
      const pending = listener.next();
      const res = await fetch(at("/callback?code=abc&state=xyz&iss=https%3A%2F%2Fexample.org%2Fapi%2Fauth"));
      assert.equal(res.status, 200);
      const url = await pending;
      assert.equal(url.searchParams.get("code"), "abc");
      assert.equal(url.searchParams.get("state"), "xyz");
      // Another path on the port is not the callback.
      assert.equal((await fetch(at("/other"))).status, 404);
      // A callback that arrives before anyone waits is kept.
      await fetch(at("/callback?error=access_denied&state=s2"));
      assert.equal((await listener.next()).searchParams.get("error"), "access_denied");
    } finally {
      await listener.stop();
    }
  });

  test("a fixed port is kept as given: url is the redirect URI itself", async () => {
    const probe = await startCallbackListener("http://127.0.0.1:0/cb");
    const port = probe.url.port;
    await probe.stop();
    const listener = await startCallbackListener(`http://127.0.0.1:${port}/cb`);
    try {
      assert.equal(listener.url.href, `http://127.0.0.1:${port}/cb`);
    } finally {
      await listener.stop();
    }
  });
});

// Task 10.7 (cold review of #51, B4): a failing sign-in or consent page can show the
// signed-in address, a client name or a code in its URL. In CI (public repository)
// describePage writes no screenshot; the job log gets the path, headings and buttons only.
describe("describePage", () => {
  function fakePage(shots: string[]): import("@playwright/test").Page {
    const none = { allTextContents: () => Promise.resolve(["Allow access?"]), evaluateAll: () => Promise.resolve(["Allow"]) };
    return {
      url: () => "https://pr-12.dev.example/consent?code=SECRET-CODE&state=s",
      getByRole: () => none,
      screenshot: (o: { path: string }) => (shots.push(o.path), Promise.resolve(Buffer.alloc(0))),
    } as unknown as import("@playwright/test").Page;
  }
  async function withCi<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const before = process.env["CI"];
    if (value === undefined) delete process.env["CI"];
    else process.env["CI"] = value;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env["CI"];
      else process.env["CI"] = before;
    }
  }

  test("in CI: no screenshot is written, and the description holds the path without its query", async () => {
    for (const ci of ["true", "1"]) {
      const shots: string[] = [];
      const out = await withCi(ci, () => describePage(fakePage(shots), "unit"));
      assert.deepEqual(shots, [], `CI=${ci}: a screenshot was written`);
      assert.match(out, /screenshot none \(CI\)/);
      assert.ok(out.includes("/consent") && !out.includes("SECRET-CODE"), out);
    }
  });

  test("outside CI: a screenshot is written for the developer", async () => {
    const shots: string[] = [];
    await withCi(undefined, () => describePage(fakePage(shots), "unit"));
    assert.equal(shots.length, 1);
  });
});

// m2-approval-page 6.1 (race seen on pr-82): after "Disconnect" is confirmed the row's
// revoke is a server action the page awaits; `waitForLoadState("load")` resolves at once
// on a page that is already loaded, so the reload that followed could abort the revoke
// and find the same row again. disconnectAll waits for the row's "<client> is
// disconnected" notice, the page's own proof that the revoke was recorded.
describe("disconnectAll", () => {
  /** A connected-apps page whose revoke completes only if no reload interrupts it. */
  function fakeClientsPage(names: string[]) {
    const rows = [...names];
    let pending: { name: string; done: Promise<void>; finish: () => void } | undefined;
    let notice: string | undefined;
    const calls: string[] = [];
    const settle = async () => {
      // The server action needs a few turns of the event loop; a reload before then aborts it.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    const page = {
      goto: () => (calls.push("goto"), Promise.resolve(null)),
      close: () => Promise.resolve(),
      reload: () => {
        calls.push("reload");
        pending = undefined; // a revoke still in flight is aborted by the navigation
        notice = undefined;
        return Promise.resolve(null);
      },
      waitForLoadState: () => (calls.push("waitForLoadState"), Promise.resolve()),
      waitForTimeout: () => Promise.resolve(),
      getByRole: (role: string, o?: { name?: string | RegExp; exact?: boolean }) => {
        if (role === "group") {
          return {
            getByRole: () => ({
              click: () => {
                calls.push("confirm");
                const name = rows[0]!;
                let finish!: () => void;
                const done = new Promise<void>((r) => (finish = r));
                const p = { name, done, finish };
                pending = p;
                void settle().then(() => {
                  if (pending !== p) return; // aborted
                  rows.shift();
                  notice = `${name} is disconnected`;
                  p.finish();
                });
                return Promise.resolve();
              },
            }),
          };
        }
        assert.equal(role, "button");
        assert.ok(o?.name instanceof RegExp);
        const first = { count: () => Promise.resolve(rows.length > 0 ? 1 : 0), click: () => (calls.push("disconnect"), Promise.resolve()) };
        return { first: () => first };
      },
      getByText: (text: string | RegExp) => ({
        waitFor: async () => {
          calls.push("wait-notice");
          if (pending) await pending.done;
          const matches = notice !== undefined && (typeof text === "string" ? notice.includes(text) : text.test(notice));
          if (!matches) throw new Error("locator.waitFor: Timeout (no notice)");
        },
      }),
    };
    const context = { newPage: () => Promise.resolve(page) } as unknown as import("@playwright/test").BrowserContext;
    return { context, calls, rows };
  }

  test("waits for each row's 'is disconnected' notice before reloading, so no revoke is aborted", async () => {
    const { context, calls, rows } = fakeClientsPage(["A2H QA verify client", "Claude"]);
    const count = await disconnectAll(context, "https://pr-12.dev.example");
    assert.equal(count, 2);
    assert.deepEqual(rows, [], "every app was disconnected");
    for (let i = 0; i < calls.length; i++) {
      if (calls[i] === "confirm") assert.equal(calls[i + 1], "wait-notice", `after a confirm: ${calls.slice(i).join(", ")}`);
    }
  });
});

// m2-approval-page 6.1: the contract and adversarial suites approve requests on the
// approval page as the QA principals, with the browser sessions this script signed in.
// The session files hold session cookies: written 0600 in a private directory, named
// in the environment by path only, never printed.
describe("saveSession", () => {
  test("writes the context's storage state 0600 in a private directory and returns its path", async () => {
    const fs = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const parent = fs.mkdtempSync(join(tmpdir(), "a2h-session-"));
    try {
      const context = {
        storageState: (o: { path: string }) => Promise.resolve(fs.writeFileSync(o.path, JSON.stringify({ cookies: [{ name: "s", value: "SECRET" }], origins: [] }))),
      } as unknown as import("@playwright/test").BrowserContext;
      const dir = join(parent, "sessions");
      const path = await saveSession(context, dir, "a");
      assert.equal(path, join(dir, "session-a.json"));
      assert.equal(fs.statSync(path).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o077, 0, "the directory is private");
      assert.match(fs.readFileSync(path, "utf8"), /SECRET/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
