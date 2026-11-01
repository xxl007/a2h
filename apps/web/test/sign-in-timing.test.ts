// Spec principal-identity "Unknown address": nothing tells an unknown address
// from an allow-listed one, the response time included. In-process, no
// network: the link creation and the mail are simulated with a delay like
// the Data API's and S3's; the real clock and timers are used.
import { describe, expect, test } from "vitest";
import type { Auth } from "../src/auth/auth";
import { requestMagicLink, ResponsePacer } from "../src/auth/sign-in";
import { createLogger } from "../src/log";

const SAMPLES = 20;
const FLOOR_MS = 150;
const BOUND_MS = 25;

function deps(pacer: ResponsePacer) {
  const auth = {
    api: {
      // 40 to 110 ms of "work" for an allowed address.
      signInMagicLink: () => new Promise((r) => setTimeout(r, 40 + Math.random() * 70)),
    },
  } as unknown as Auth;
  return {
    auth,
    isAllowed: (email: string) => Promise.resolve(email === "known@example.com"),
    logger: createLogger({ write: () => undefined }),
    pacer,
  };
}

async function time(d: ReturnType<typeof deps>, email: string): Promise<number> {
  const t0 = performance.now();
  await requestMagicLink(d, { email, next: undefined, headers: new Headers() });
  return performance.now() - t0;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe("sign-in answers in the same time for a known and an unknown address", () => {
  test(`${SAMPLES} samples each, interleaved: means and medians within ${BOUND_MS} ms`, async () => {
    const d = deps(new ResponsePacer(FLOOR_MS));
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      known.push(await time(d, "known@example.com"));
      unknown.push(await time(d, "stranger@example.org"));
    }
    // Means and medians; a single sample can carry timer or GC jitter on either side.
    expect(Math.abs(mean(known) - mean(unknown)), `means ${mean(known)} ${mean(unknown)}`).toBeLessThan(BOUND_MS);
    expect(Math.abs(median(known) - median(unknown)), `medians ${median(known)} ${median(unknown)}`).toBeLessThan(BOUND_MS);
    expect(Math.min(...unknown)).toBeGreaterThanOrEqual(FLOOR_MS - 2);
  }, 30_000);

  test("work slower than the floor raises the target for everyone, unknown addresses included", async () => {
    const pacer = new ResponsePacer(50);
    pacer.observe(400);
    expect(pacer.target).toBeGreaterThan(50);
    const t = await time(deps(pacer), "stranger@example.org");
    expect(t).toBeGreaterThanOrEqual(pacer.target - 5);
  });

  test("a delivery failure is reported only after the same time", async () => {
    const d = deps(new ResponsePacer(FLOOR_MS));
    (d.auth.api as unknown as { signInMagicLink: () => Promise<never> }).signInMagicLink = () => Promise.reject(new Error("sink down"));
    const t0 = performance.now();
    await expect(requestMagicLink(d, { email: "known@example.com", next: undefined, headers: new Headers() })).rejects.toThrow("sink down");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(FLOOR_MS - 2);
  });
});
